import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { checkConformance } from "../../src/conformance.js";
import type { Model, PortableTrace } from "../../src/contracts.js";
import {
  checkFiniteHistory,
  compileFiniteModel,
  createFiniteModel,
} from "../../src/finite.js";
import { createSimulationHost } from "../../src/host.js";
import { toPortableTrace, toPortableValue } from "../../src/portable.js";
import { deletionCandidates } from "../../src/shrink.js";
import {
  createMutexDriver,
  loadMutex,
  mutexModel,
  mutexRegression,
} from "../usable/mutex.js";
import { exerciseHost } from "../usable/scenario.js";

const branchModel: Model<string, string, number> = {
  name: "go-branches",
  initial: () => [
    { state: "left", observation: 0 },
    { state: "right", observation: 0 },
  ],
  actions: () => ["next"],
  step: (state, action) =>
    action === "next" ? [{ state, observation: state === "left" ? 1 : 2 }] : [],
  key: (state) => state,
};
const branches = compileFiniteModel(branchModel, {
  maxDepth: 1,
  maxStates: 2,
});
const mutex = compileFiniteModel(mutexModel, { maxDepth: 20, maxStates: 100 });
assert.equal(branches.status, "complete");
assert.equal(mutex.status, "complete");
assert.ok(branches.model);
assert.ok(mutex.model);
const finiteBranches = branches.model;
const finiteMutex = mutex.model;
const preparedBranches = createFiniteModel(finiteBranches);
const preparedMutex = createFiniteModel(finiteMutex);
const branchHistories: PortableTrace[] = [
  [0, []],
  [0, [1, 1]],
  [0, [2, 2]],
  [0, [1, 2]],
  [0, [2, 1]],
  [3, []],
].map(([initial, observations]) => {
  assert.equal(typeof initial, "number");
  assert.ok(Array.isArray(observations));
  return {
    format: "modelt.portable-trace",
    version: 1,
    model: branchModel.name,
    initial: toPortableValue(initial),
    steps: observations.map((observation) => ({
      action: toPortableValue("next"),
      observation: toPortableValue(observation),
    })),
  };
});
branchHistories.push({
  format: "modelt.portable-trace",
  version: 1,
  model: branchModel.name,
  initial: toPortableValue(0),
  steps: [
    { action: toPortableValue("unknown"), observation: toPortableValue(9) },
  ],
});
const mutexHistories = [];
for (const revision of ["before", "after"] as const) {
  const result = await checkConformance(
    mutexModel,
    createMutexDriver(await loadMutex(revision)),
    mutexRegression,
  );
  assert.equal(result.status, revision === "before" ? "mismatch" : "matched");
  mutexHistories.push(toPortableTrace(result.trace));
}
const host = createSimulationHost({ seed: 3 });
exerciseHost(host);
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
await mkdir(".artifacts/go", { recursive: true });
const fixture = {
  version: 1,
  wasmSha256: createHash("sha256").update(bytes).digest("hex"),
  batches: [
    {
      name: "branches",
      model: finiteBranches,
      cases: await Promise.all(
        branchHistories.map(async (history) => ({
          history,
          expected: await checkFiniteHistory(preparedBranches, history),
        })),
      ),
    },
    {
      name: "archived-async-mutex",
      model: finiteMutex,
      cases: await Promise.all(
        mutexHistories.map(async (history) => ({
          history,
          expected: await checkFiniteHistory(preparedMutex, history),
        })),
      ),
    },
  ],
  host: {
    tape: host.trace(),
    snapshot: toPortableValue({
      clock: 10,
      running: true,
      storage: { counter: 1 },
      pending: [],
    }),
  },
  candidates: Array.from({ length: 17 }, (_, length) => ({
    length,
    ranges: deletionCandidates(length),
  })),
};
await writeFile(".artifacts/go/fixtures.json", JSON.stringify(fixture));
console.log(
  "Prepared 9 TS histories, one host tape and 17 shrink cases for Go",
);
