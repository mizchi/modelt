import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { counterModel } from "../../examples/counter-model.js";
import { createCounter } from "../../examples/durable-counter.js";
import { checkConformance } from "../../src/conformance.js";
import {
  checkFiniteHistory,
  compileFiniteModel,
  createFiniteModel,
} from "../../src/finite.js";
import { createSimulationHost } from "../../src/host.js";
import {
  checkFiniteConformance,
  checkFiniteHistories,
  coreDeletionCandidates,
  createPortableWasm,
  fromPortableValue,
  toPortableTrace,
  toPortableValue,
  verifyHostTape,
} from "../../src/portable.js";
import { deletionCandidates, shrinkCounterexample } from "../../src/shrink.js";
import { exerciseHost } from "./scenario.js";

test("the same host tape replays in TS, Rust/Wasm and native Rust", async () => {
  const host = createSimulationHost({ seed: 3 });
  exerciseHost(host);
  const tape = host.trace();
  const core = await wasm();
  const expected = toPortableValue({
    clock: 10,
    running: true,
    storage: { counter: 1 },
    pending: [],
  });
  assert.deepEqual(verifyHostTape(core, tape), expected);
  const native = JSON.parse(
    execFileSync("crates/modelt-core/target/release/modelt-core", {
      input: JSON.stringify({
        version: 1,
        request: { kind: "replay-host", tape },
      }),
    }).toString(),
  );
  assert.deepEqual(native.snapshot, expected);
});

import {
  createMutexDriver,
  isMutexAction,
  loadMutex,
  mutexModel,
  mutexRegression,
} from "./mutex.js";

const wasm = async () =>
  createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
test("the original upstream mutex regression fails before the fix and passes after it", async () => {
  const before = await loadMutex("before");
  const after = await loadMutex("after");
  const broken = await checkConformance(
    mutexModel,
    createMutexDriver(before),
    mutexRegression,
  );
  assert.equal(broken.status, "mismatch");
  assert.equal(
    (
      await checkConformance(
        mutexModel,
        createMutexDriver(after),
        mutexRegression,
      )
    ).status,
    "matched",
  );
  const core = await wasm();
  const shrunk = await shrinkCounterexample(
    mutexRegression,
    async (actions) => {
      const result = await checkConformance(
        mutexModel,
        createMutexDriver(before),
        actions,
      );
      return result.status === "mismatch"
        ? { status: "mismatch", signature: "stranded-mutex" }
        : { status: result.status };
    },
    {
      maxChecks: 100,
      candidates: (length) => coreDeletionCandidates(core, length),
    },
  );
  assert.equal(shrunk.status, "minimal");
  assert.equal(shrunk.actions.length, 4);
  assert.equal(
    (
      await checkConformance(
        mutexModel,
        createMutexDriver(after),
        shrunk.actions,
      )
    ).status,
    "matched",
  );
});

test("one finite artifact runs on TS, Rust/Wasm and Rust native", async () => {
  const compiled = compileFiniteModel(mutexModel, {
    maxDepth: 20,
    maxStates: 2000,
  });
  assert.ok(compiled.model);
  const model = createFiniteModel(compiled.model);
  const core = await wasm();
  const histories = [];
  for (const revision of ["before", "after"] as const) {
    const factory = await loadMutex(revision);
    const original = await checkConformance(
      mutexModel,
      createMutexDriver(factory),
      mutexRegression,
    );
    const trace = toPortableTrace(original.trace);
    histories.push(trace);
    const driver = createMutexDriver(factory);
    const portable = await checkFiniteConformance(
      core,
      compiled.model,
      {
        reset: async () => toPortableValue(await driver.reset()),
        step: async (value) => {
          const action = fromPortableValue(value);
          assert.ok(isMutexAction(action));
          return toPortableValue(await driver.step(action));
        },
        dispose: () => driver.dispose?.(),
      },
      mutexRegression.map(toPortableValue),
    );
    assert.equal(portable.status, original.status);
    assert.deepEqual(
      checkFiniteHistories(core, compiled.model, [trace])[0],
      await checkFiniteHistory(model, trace),
    );
  }
  const command = {
    version: 1,
    request: { kind: "check-finite", model: compiled.model, traces: histories },
  };
  const native = JSON.parse(
    execFileSync("crates/modelt-core/target/release/modelt-core", {
      input: JSON.stringify(command),
    }).toString(),
  );
  assert.deepEqual(
    native.results,
    checkFiniteHistories(core, compiled.model, histories),
  );
});

test("shared shrinking candidates and counter artifact preserve existing verdicts", async () => {
  const core = await wasm();
  for (let length = 0; length < 33; length++)
    assert.deepEqual(
      coreDeletionCandidates(core, length),
      deletionCandidates(length),
    );
  const compiled = compileFiniteModel(counterModel, {
    maxDepth: 20,
    maxStates: 1000,
  });
  assert.ok(compiled.model);
  const actions = [
    { type: "add", id: "a", amount: 1 },
    { type: "crash" },
    { type: "restart" },
  ] as const;
  for (const persist of [true, false]) {
    const original = await checkConformance(
      counterModel,
      createCounter({ persist }),
      actions,
    );
    const trace = toPortableTrace(original.trace);
    assert.deepEqual(
      checkFiniteHistories(core, compiled.model, [trace])[0],
      await checkFiniteHistory(createFiniteModel(compiled.model), trace),
    );
  }
});
