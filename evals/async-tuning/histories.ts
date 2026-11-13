import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { ConcurrentHistory, FiniteModel } from "../../src/contracts.js";
import { compileFiniteModel } from "../../src/finite.js";
import {
  checkConcurrentHistory,
  createHistoryRecorder,
} from "../../src/history.js";
import {
  createPortableWasm,
  loadFiniteModel,
  toPortableValue,
} from "../../src/portable.js";
import { checkHistory, incrementHistoryModel } from "../harness/history.js";
import {
  interleavings,
  runScheduledCounter,
} from "../harness/scheduled-counter.js";

interface Case {
  readonly history: ConcurrentHistory;
  readonly maxNodes: number;
}
export const compareHistories = async (
  model: FiniteModel,
  cases: readonly Case[],
) => {
  const expected = cases.map((entry) =>
    checkConcurrentHistory(model, entry.history, entry.maxNodes),
  );
  const core = await createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
  const loaded = loadFiniteModel(core, model);
  assert.deepEqual(
    cases.map((entry) => loaded.checkHistory(entry.history, entry.maxNodes)),
    expected,
  );
  loaded.release();
  const native = execFileSync("crates/modelt-core/target/release/modelt-core", {
    input: [
      JSON.stringify({ version: 1, request: { kind: "load-model", model } }),
      ...cases.map((entry) =>
        JSON.stringify({
          version: 1,
          request: { kind: "check-history", handle: 1, ...entry },
        }),
      ),
    ].join("\n"),
    maxBuffer: 16 * 1024 * 1024,
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
      { input: JSON.stringify({ model, cases }), maxBuffer: 16 * 1024 * 1024 },
    ).toString(),
  );
  assert.deepEqual(go, expected);
  return expected;
};

export const liveHistories = async () => {
  const compiled = compileFiniteModel<number, number, number>(
    {
      name: "increment",
      initial: () => [{ state: 0, observation: 0 }],
      key: String,
      actions: (state) => (state < 2 ? [1] : []),
      step: (state) => [{ state: state + 1, observation: state + 1 }],
    },
    { maxDepth: 2, maxStates: 3 },
  );
  assert.ok(compiled.model);
  const cases: Case[] = [];
  const references = [];
  for (const broken of [false, true])
    for (const ordering of interleavings) {
      const run = await runScheduledCounter(broken, ordering);
      const history: ConcurrentHistory = {
        format: "modelt.concurrent-history",
        version: 1,
        model: "increment",
        initial: toPortableValue(0),
        events: run.history
          .flatMap((operation) => [
            {
              at: operation.call,
              event: {
                kind: "invoke" as const,
                id: operation.id,
                action: toPortableValue(operation.input),
              },
            },
            {
              at: operation.returned,
              event: {
                kind: "return" as const,
                id: operation.id,
                observation: toPortableValue(operation.output),
              },
            },
          ])
          .sort((left, right) => left.at - right.at)
          .map((entry) => entry.event),
      };
      const reference = checkHistory(incrementHistoryModel, run.history, 1000);
      assert.equal(
        checkConcurrentHistory(compiled.model, history, 1000).status,
        reference.status,
      );
      cases.push({ history, maxNodes: 1000 });
      references.push({ broken, ordering, status: reference.status });
    }
  const results = await compareHistories(compiled.model, cases);
  assert.ok(
    references.some(
      (entry) => entry.broken && entry.status === "not-linearizable",
    ),
  );
  assert.ok(
    references
      .filter((entry) => !entry.broken)
      .every((entry) => entry.status === "linearizable"),
  );
  return { model: compiled.model, cases, results, references };
};

export const uncertainHistories = async () => {
  const compiled = compileFiniteModel<number, string, number | string>(
    {
      name: "register",
      initial: () => [{ state: 0, observation: 0 }],
      key: String,
      actions: () => ["write", "read"],
      step: (state, action) =>
        action === "write"
          ? [{ state: 1, observation: "ok" }]
          : [{ state, observation: state }],
    },
    { maxDepth: 2, maxStates: 2 },
  );
  assert.ok(compiled.model);
  const cases: Case[] = [];
  for (const outcome of ["unknown", "cancel", "fail"] as const)
    for (const observed of [0, 1]) {
      let value = 0;
      const recorder = createHistoryRecorder(
        "register",
        toPortableValue(value),
      );
      recorder.invoke("w", toPortableValue("write"));
      if (observed === 1) value = 1;
      recorder.end("w", outcome);
      recorder.invoke("r", toPortableValue("read"));
      recorder.returned("r", toPortableValue(value));
      for (const maxNodes of [1, 100])
        cases.push({ history: recorder.snapshot(), maxNodes });
      if (outcome !== "fail") {
        value = 1;
        recorder.returned("w", toPortableValue("ok"));
        for (const maxNodes of [1, 100])
          cases.push({ history: recorder.snapshot(), maxNodes });
      }
    }
  return {
    model: compiled.model,
    cases,
    results: await compareHistories(compiled.model, cases),
  };
};
