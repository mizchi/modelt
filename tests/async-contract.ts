import assert from "node:assert/strict";
import { checkConformance, checkTrace } from "../src/conformance.js";
import { compileFiniteModel } from "../src/finite.js";
import {
  checkConcurrentHistory,
  createHistoryRecorder,
  parseConcurrentHistory,
} from "../src/history.js";
import { toPortableValue } from "../src/portable.js";
import { shrinkCounterexample } from "../src/shrink.js";

const model = compileFiniteModel<number, string, number | string>(
  {
    name: "register",
    initial: () => [{ state: 0, observation: 0 }],
    key: String,
    actions: () => ["write", "read"],
    step: (state: number, action: string) =>
      action === "write"
        ? [{ state: 1, observation: "ok" }]
        : [{ state, observation: state }],
  },
  { maxDepth: 2, maxStates: 2 },
);
assert.ok(model.model);
const artifact = model.model;

export const registerAsyncContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("late responses resolve uncertainty at their actual event position", () => {
    const history = createHistoryRecorder("register", toPortableValue(0));
    history.invoke("w", toPortableValue("write"));
    history.end("w", "unknown");
    history.invoke("r", toPortableValue("read"));
    history.returned("r", toPortableValue(1));
    history.returned("w", toPortableValue("ok"));
    const result = checkConcurrentHistory(artifact, history.snapshot(), 100);
    assert.equal(result.status, "linearizable");
    assert.deepEqual(result.pending, []);
  });
  test("history formats reject unmatched ids, duplicate outcomes and unsupported metadata", () => {
    const history = createHistoryRecorder("register", toPortableValue(0));
    assert.throws(() => history.returned("missing", toPortableValue(0)), /id/);
    history.invoke("a", toPortableValue("read"));
    history.end("a", "cancel");
    history.returned("a", toPortableValue(0));
    assert.throws(() => history.returned("a", toPortableValue(0)), /id/);
    const value = history.snapshot();
    for (const input of [
      { ...value, version: 2 },
      { ...value, extra: 0 },
      {
        ...value,
        events: [
          { kind: "return", id: "no-call", observation: toPortableValue(0) },
        ],
      },
    ])
      assert.throws(() => parseConcurrentHistory(input));
  });
  test("trace buffers return isolated full snapshots and the exact failure prefix", async () => {
    const model = {
      name: "increment",
      initial: () => [{ state: 0, observation: 0 }],
      key: String,
      actions: () => [1],
      step: (state: number, input: number) => [
        { state: state + input, observation: state + input },
      ],
    };
    let value = 0;
    const normal = await checkConformance(
      model,
      {
        reset: () => {
          value = 0;
          return value;
        },
        step: (input) => {
          value += input;
          return value;
        },
      },
      Array.from({ length: 64 }, () => 1),
    );
    let steps = 0;
    const broken = await checkTrace(normal.trace, {
      reset: () => 0,
      step: () => {
        steps++;
        return steps === 16 ? -1 : steps;
      },
    });
    assert.equal(normal.trace.steps.length, 64);
    assert.deepEqual(normal.trace.steps.at(-1), { action: 1, observation: 64 });
    assert.equal(broken.status, "mismatch");
    assert.equal(broken.trace.steps.length, 16);
  });
  test("unknown and cancel may take effect, confirmed failures cannot", () => {
    for (const outcome of ["unknown", "cancel", "fail"] as const) {
      const recorder = createHistoryRecorder("register", toPortableValue(0));
      recorder.invoke("w", toPortableValue("write"));
      recorder.end("w", outcome);
      recorder.invoke("r", toPortableValue("read"));
      recorder.returned("r", toPortableValue(1));
      const result = checkConcurrentHistory(artifact, recorder.snapshot(), 100);
      assert.equal(
        result.status,
        outcome === "fail" ? "not-linearizable" : "linearizable",
      );
      if (outcome !== "fail") assert.deepEqual(result.order, ["w", "r"]);
    }
  });

  test("concurrent responses may reorder, real-time order and budgets are preserved", () => {
    const recorder = createHistoryRecorder("register", toPortableValue(0));
    recorder.invoke("w", toPortableValue("write"));
    recorder.invoke("r", toPortableValue("read"));
    recorder.returned("r", toPortableValue(1));
    recorder.returned("w", toPortableValue("ok"));
    assert.equal(
      checkConcurrentHistory(artifact, recorder.snapshot(), 100).status,
      "linearizable",
    );
    assert.equal(
      checkConcurrentHistory(artifact, recorder.snapshot(), 1).status,
      "inconclusive",
    );
    const stale = createHistoryRecorder("register", toPortableValue(0));
    stale.invoke("w", toPortableValue("write"));
    stale.returned("w", toPortableValue("ok"));
    stale.invoke("r", toPortableValue("read"));
    stale.returned("r", toPortableValue(0));
    assert.equal(
      checkConcurrentHistory(artifact, stale.snapshot(), 100).status,
      "not-linearizable",
    );
    const empty = createHistoryRecorder("register", toPortableValue(0));
    const snapshot = empty.snapshot();
    assert.equal(
      checkConcurrentHistory(artifact, snapshot, 100).status,
      "empty",
    );
    empty.invoke("pending", toPortableValue("write"));
    assert.equal(snapshot.events.length, 0);
    assert.deepEqual(
      checkConcurrentHistory(artifact, empty.snapshot(), 100).omitted,
      ["pending"],
    );
    assert.throws(
      () => empty.invoke("pending", toPortableValue("read")),
      /id/i,
    );
    assert.throws(() => empty.returned("missing", toPortableValue(1)), /id/i);
    assert.throws(
      () => checkConcurrentHistory(artifact, empty.snapshot(), 0),
      /budget/i,
    );
  });

  test("causal shrinking can remove dependent pairs and preflight invalid histories", async () => {
    await assert.rejects(
      shrinkCounterexample(
        ["deliver"],
        async () => {
          throw new Error("Invalid baseline reached the SUT");
        },
        { maxChecks: 10, isEnabled: () => false },
      ),
      /not enabled/,
    );
    let calls = 0;
    const evaluate = async (actions: readonly string[]) => {
      calls++;
      assert.equal(actions.includes("send"), actions.includes("deliver"));
      return actions.includes("bug")
        ? { status: "mismatch" as const, signature: "bug" }
        : { status: "matched" as const };
    };
    const result = await shrinkCounterexample(
      ["send", "bug", "deliver"],
      evaluate,
      {
        maxChecks: 30,
        isEnabled: (actions) =>
          actions.includes("send") === actions.includes("deliver"),
        dependencies: (actions) =>
          actions.includes("send")
            ? [
                {
                  producer: actions.indexOf("send"),
                  consumer: actions.indexOf("deliver"),
                },
              ]
            : [],
      },
    );
    assert.deepEqual(result.actions, ["bug"]);
    assert.equal(result.status, "minimal");
    assert.equal(result.checks, calls);
  });
};
