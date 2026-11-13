import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { counterModel } from "../../examples/counter-model.js";
import {
  createCounter,
  isCounterAction,
} from "../../examples/durable-counter.js";
import { checkConformance, checkTrace } from "../../src/conformance.js";
import type {
  Driver,
  Model,
  PortableCommand,
  PortableCore,
  PortableOutput,
} from "../../src/contracts.js";
import {
  checkPortableConformance,
  checkPortableTrace,
  createPortableWasm,
  fromPortableValue,
  normalizePortableValue,
  PortableCoreError,
  toPortableTrace,
  toPortableValue,
} from "../../src/portable.js";
import {
  counterFaults,
  createFaultyCounter,
} from "../harness/counter-faults.js";
import { generateCorpus } from "../harness/search.js";
import { createNativeComparison } from "./transcript.js";

test("independent native and Wasm instances have matching protocol lifetimes", async () => {
  const bytes = await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  );
  for (const seed of [1, 2]) {
    const comparison = await createNativeComparison(bytes);
    for (const actions of generateCorpus(counterModel, "alternating", {
      seed,
      maxOperations: 32,
      maxDepth: 8,
    }).cases)
      await checkPortableConformance(
        comparison.core,
        counterModel,
        createCounter(),
        actions,
      );
    assert.ok(comparison.verify().replies > 0);
  }
});

const load = async () =>
  createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
const decodeAction = (value: Parameters<typeof fromPortableValue>[0]) => {
  const action = fromPortableValue(value);
  if (!isCounterAction(action)) throw new Error("Invalid counter action");
  return action;
};

test("Rust native and Wasm process the same conformance transcripts as the original TS checker", async () => {
  const wasm = await load();
  const commands: PortableCommand[] = [];
  const expected: PortableOutput[] = [];
  const core: PortableCore = {
    request: (command) => {
      commands.push(structuredClone(command));
      const output = wasm.request(command);
      expected.push(output);
      return output;
    },
  };
  for (const actions of generateCorpus(counterModel, "alternating", {
    seed: 1,
    maxOperations: 128,
    maxDepth: 16,
  }).cases) {
    for (const fault of ["none", ...counterFaults] as const) {
      const reference = await checkConformance(
        counterModel,
        createFaultyCounter(fault),
        actions,
      );
      const actual = await checkPortableConformance(
        core,
        counterModel,
        createFaultyCounter(fault),
        actions,
      );
      assert.deepEqual(actual, {
        ...reference,
        actual: toPortableValue(reference.actual),
        expected: reference.expected.map(toPortableValue),
        trace: toPortableTrace(reference.trace),
      });
    }
  }
  const native = execFileSync("crates/modelt-core/target/release/modelt-core", {
    input: commands.map((command) => JSON.stringify(command)).join("\n"),
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(native, expected);
});

test("portable replay uses the saved oracle and reproduces a persistence fault", async () => {
  const core = await load();
  const actions = [
    { type: "add", id: "a", amount: 1 },
    { type: "crash" },
    { type: "restart" },
  ] as const;
  const oracle = await checkConformance(counterModel, createCounter(), actions);
  for (const persist of [true, false]) {
    const expected = await checkTrace(oracle.trace, createCounter({ persist }));
    const actual = await checkPortableTrace(
      core,
      toPortableTrace(oracle.trace),
      createCounter({ persist }),
      decodeAction,
    );
    assert.equal(actual.status, expected.status);
    assert.deepEqual(actual.trace, toPortableTrace(expected.trace));
    assert.equal(actual.checkedSteps, 3);
  }
});

test("candidate histories remain consistent and invalid input never executes a driver step", async () => {
  const core = await load();
  const model: Model<string, string, number> = {
    name: "branches",
    initial: () => [
      { state: "left", observation: 0 },
      { state: "right", observation: 0 },
    ],
    actions: () => ["next"],
    step: (state) => [{ state, observation: state === "left" ? 1 : 2 }],
    key: (state) => state,
  };
  let current = 0;
  const driver = (): Driver<string, number> => ({
    reset: () => {
      current = 0;
      return current;
    },
    step: () => ++current,
  });
  const expected = await checkConformance(model, driver(), ["next", "next"]);
  const actual = await checkPortableConformance(core, model, driver(), [
    "next",
    "next",
  ]);
  assert.equal(actual.status, "mismatch");
  assert.deepEqual(actual.expected, expected.expected.map(toPortableValue));
  assert.equal(actual.checkedSteps, 2);
  const empty = await checkPortableConformance(
    core,
    { ...model, initial: () => [] },
    driver(),
    [],
  );
  assert.equal(empty.status, "invalid");
  const invalid = await checkPortableConformance(
    core,
    { ...model, step: () => [] },
    driver(),
    ["invalid"],
  );
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.checkedSteps, 0);
  assert.equal(current, 0);
});

test("the Wasm codec follows the shared fixtures and protocol rejects stale replies", async () => {
  const core = await load();
  const fixtures = JSON.parse(
    await readFile("fixtures/portable-values.json", "utf8"),
  );
  for (const fixture of fixtures.valid)
    assert.deepEqual(
      core.request({
        version: 1,
        request: { kind: "canonicalize", value: fixture.input },
      }),
      { kind: "value", value: normalizePortableValue(fixture.input) },
    );
  for (const fixture of fixtures.invalid)
    assert.throws(
      () =>
        core.request({
          version: 1,
          request: {
            kind: "canonicalize",
            value: fixture.json ? JSON.parse(fixture.json) : fixture.input,
          },
        }),
      PortableCoreError,
    );
  const start = core.request({
    version: 1,
    request: { kind: "start", model: "test", actions: [] },
  });
  assert.equal(start.kind, "effect");
  assert.throws(
    () =>
      core.request({
        version: 1,
        request: {
          kind: "resume",
          id: 2,
          response: { kind: "transitions", transitions: [] },
        },
      }),
    PortableCoreError,
  );
  core.request({ version: 1, request: { kind: "cancel", id: 1 } });
  const next = core.request({
    version: 1,
    request: { kind: "start", model: "test", actions: [] },
  });
  assert.ok(next.kind === "effect" && next.effect.kind === "model-initial");
  assert.equal(next.effect.id, 2);
  assert.throws(
    () =>
      core.request({
        version: 1,
        request: {
          kind: "resume",
          id: 1,
          response: { kind: "transitions", transitions: [] },
        },
      }),
    PortableCoreError,
  );
});

test("driver exceptions dispose the implementation and release the core session", async () => {
  const core = await load();
  let disposed = 0;
  const driver = createCounter();
  await assert.rejects(
    checkPortableConformance(
      core,
      counterModel,
      {
        ...driver,
        step: () => {
          throw new Error("I/O failed");
        },
        dispose: () => {
          disposed++;
        },
      },
      [{ type: "add", id: "a", amount: 1 }],
    ),
    /I\/O failed/,
  );
  assert.equal(disposed, 1);
  assert.equal(
    (await checkPortableConformance(core, counterModel, createCounter(), []))
      .status,
    "matched",
  );
});

test("encoding errors clean up and lossy state encodings are rejected", async () => {
  const core = await load();
  let disposed = 0;
  await assert.rejects(
    checkPortableConformance(
      core,
      counterModel,
      {
        ...createCounter(),
        dispose: () => {
          disposed++;
        },
      },
      [{ type: "crash" }],
      {
        action: () => {
          throw new Error("bad encoding");
        },
      },
    ),
    /bad encoding/,
  );
  assert.equal(disposed, 1);
  const model: Model<string, string, number> = {
    name: "distinct",
    initial: () => [
      { state: "a", observation: 0 },
      { state: "b", observation: 0 },
    ],
    actions: () => [],
    step: () => [],
    key: (state) => state,
  };
  await assert.rejects(
    checkPortableConformance(
      core,
      model,
      { reset: () => 0, step: () => 0 },
      [],
      { state: () => toPortableValue(null) },
    ),
    /state encoding/i,
  );
  assert.equal(
    (await checkPortableConformance(core, counterModel, createCounter(), []))
      .status,
    "matched",
  );
});
