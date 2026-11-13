import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { counterModel } from "../../examples/counter-model.js";
import { compileFiniteModel } from "../../src/finite.js";
import {
  checkConcurrentHistory,
  createHistoryRecorder,
} from "../../src/history.js";
import {
  checkFiniteHistories,
  createPortableWasm,
  loadFiniteModel,
  toPortableValue,
} from "../../src/portable.js";
import { generateCorpus } from "../harness/search.js";
import { generateFeedbackCorpus } from "./feedback.js";
import { liveHistories, uncertainHistories } from "./histories.js";
import { runPatterns } from "./patterns.js";

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

test("indexed handles and concurrent histories agree across TS native Wasm and Go", async () => {
  const core = await createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
  const loaded = loadFiniteModel(core, artifact);
  const cases = ["unknown", "cancel", "fail"].flatMap((kind) => {
    const recorder = createHistoryRecorder("register", toPortableValue(0));
    recorder.invoke("w", toPortableValue("write"));
    if (kind === "unknown" || kind === "cancel" || kind === "fail")
      recorder.end("w", kind);
    recorder.invoke("r", toPortableValue("read"));
    recorder.returned("r", toPortableValue(1));
    return [1, 100].map((maxNodes) => ({
      history: recorder.snapshot(),
      maxNodes,
    }));
  });
  const expected = cases.map((entry) =>
    checkConcurrentHistory(artifact, entry.history, entry.maxNodes),
  );
  assert.deepEqual(
    cases.map((entry) => loaded.checkHistory(entry.history, entry.maxNodes)),
    expected,
  );
  const native = execFileSync("crates/modelt-core/target/release/modelt-core", {
    input: [
      JSON.stringify({
        version: 1,
        request: { kind: "load-model", model: artifact },
      }),
      ...cases.map((entry) =>
        JSON.stringify({
          version: 1,
          request: { kind: "check-history", handle: 1, ...entry },
        }),
      ),
    ].join("\n"),
  })
    .toString()
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => JSON.parse(line).result);
  assert.deepEqual(native, expected);
  const go = JSON.parse(
    execFileSync(
      ".artifacts/go/history-check",
      [
        "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
      ],
      { input: JSON.stringify({ model: artifact, cases }) },
    ).toString(),
  );
  assert.deepEqual(go, expected);
  const trace = {
    format: "modelt.portable-trace",
    version: 1,
    model: "register",
    initial: toPortableValue(0),
    steps: [],
  } as const;
  assert.deepEqual(
    loaded.checkHistories([trace]),
    checkFiniteHistories(core, artifact, [trace]),
  );
  await assert.rejects(
    loaded.checkConformance(
      {
        reset: () => {
          assert.throws(() => loaded.release(), /use/);
          throw new Error("SUT failure");
        },
        step: () => toPortableValue(0),
      },
      [],
    ),
    /SUT failure/,
  );
  loaded.release();
  assert.throws(() => loaded.checkHistories([trace]), /Released/);
});

test("live concurrent implementations and fault boundaries are load-bearing", async () => {
  await liveHistories();
  await uncertainHistories();
  await runPatterns();
});

test("feedback preserves enabled workloads, budgets and deterministic replay", () => {
  const options = { seed: 231, maxOperations: 512, maxDepth: 16 };
  const feedback = generateFeedbackCorpus(options);
  assert.deepEqual(feedback, generateFeedbackCorpus(options));
  const baseline = generateCorpus(counterModel, "alternating", options);
  assert.equal(feedback.operations, baseline.operations);
  assert.equal(feedback.cases.length, baseline.cases.length);
  assert.ok(
    feedback.features > 0 && feedback.featureCalls > feedback.modelSteps,
  );
  for (const actions of feedback.cases) {
    let state = counterModel.initial()[0]?.state;
    assert.ok(state);
    for (const action of actions) {
      const edges = counterModel.step(state, action);
      assert.equal(edges.length, 1);
      const edge = edges[0];
      assert.ok(edge);
      state = edge.state;
    }
  }
});

test("all history transports reject malformed ids and unknown fields", async () => {
  const core = await createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
  const loaded = loadFiniteModel(core, artifact);
  const base = {
    format: "modelt.concurrent-history",
    version: 1,
    model: "register",
    initial: toPortableValue(0),
  };
  const histories = [
    {
      ...base,
      events: [
        { kind: "return", id: "missing", observation: toPortableValue(0) },
      ],
    },
    { ...base, extra: 0, events: [] },
    {
      ...base,
      events: [
        { kind: "invoke", id: "\ud800", action: toPortableValue("read") },
      ],
    },
    {
      ...base,
      events: [
        { kind: "invoke", id: "a", action: toPortableValue("read") },
        { kind: "return", id: "a", observation: toPortableValue(0) },
        { kind: "return", id: "a", observation: toPortableValue(0) },
      ],
    },
  ];
  for (const history of histories) {
    assert.throws(() =>
      loaded.checkHistory(
        history as Parameters<typeof loaded.checkHistory>[0],
        100,
      ),
    );
    const lines = [
      { version: 1, request: { kind: "load-model", model: artifact } },
      {
        version: 1,
        request: { kind: "check-history", handle: 1, history, maxNodes: 100 },
      },
    ];
    const result = execFileSync(
      "crates/modelt-core/target/release/modelt-core",
      { input: lines.map((line) => JSON.stringify(line)).join("\n") },
    )
      .toString()
      .trim()
      .split("\n")
      .at(-1);
    assert.ok(result);
    assert.equal(JSON.parse(result).kind, "error");
    const go = spawnSync(
      ".artifacts/go/history-check",
      [
        "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
      ],
      {
        input: JSON.stringify({
          model: artifact,
          cases: [{ history, maxNodes: 100 }],
        }),
      },
    );
    assert.equal(go.status, 1);
  }
  loaded.release();
});
