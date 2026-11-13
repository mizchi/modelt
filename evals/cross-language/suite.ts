import assert from "node:assert/strict";
import {
  type CounterAction,
  counterModel,
} from "../../examples/counter-model.js";
import type { FiniteModel, PortableTrace } from "../../src/contracts.js";
import { compileFiniteModel, parseFiniteModel } from "../../src/finite.js";
import { toPortableTrace } from "../../src/portable.js";
import { parsePortableTrace } from "../../src/portable-value.js";
import { isRecord } from "../../src/trace.js";
import { type CounterFault, counterFaults } from "../harness/counter-faults.js";
import { generateCorpus } from "../harness/search.js";

export interface OracleCase {
  readonly id: string;
  readonly seed?: number;
  readonly oracle: PortableTrace;
}
export interface OracleSuite {
  readonly format: "modelt.oracle-suite";
  readonly version: 1;
  readonly model: FiniteModel;
  readonly faults: readonly CounterFault[];
  readonly cases: readonly OracleCase[];
}
export const isFault = (value: unknown): value is CounterFault =>
  value === "none" || counterFaults.some((fault) => fault === value);

const oracle = (actions: readonly CounterAction[]): PortableTrace => {
  const initial = counterModel.initial();
  assert.equal(initial.length, 1);
  const first = initial[0];
  assert.ok(first);
  let current = first.state;
  return toPortableTrace({
    version: 1,
    model: counterModel.name,
    initial: first.observation,
    steps: actions.map((action) => {
      const successors = counterModel.step(current, action);
      assert.equal(
        successors.length,
        1,
        "Oracle requires a deterministic enabled action",
      );
      const next = successors[0];
      assert.ok(next);
      current = next.state;
      return { action, observation: next.observation };
    }),
  });
};

export const buildSuite = (seeds: readonly number[]): OracleSuite => {
  assert.equal(new Set(seeds).size, seeds.length);
  const compiled = compileFiniteModel(counterModel, {
    maxDepth: 20,
    maxStates: 1000,
  });
  assert.equal(compiled.status, "complete");
  assert.ok(compiled.model);
  assert.ok(
    compiled.model.states.every((state) => state.violations.length === 0),
  );
  const add: CounterAction = { type: "add", id: "a", amount: 1 };
  const sendA: CounterAction = { type: "send", id: "a", amount: 1 };
  const sendB: CounterAction = { type: "send", id: "b", amount: 1 };
  const cases: OracleCase[] = [
    { id: "empty", oracle: oracle([]) },
    {
      id: "persistence",
      oracle: oracle([add, { type: "crash" }, { type: "restart" }]),
    },
    { id: "deduplication", oracle: oracle([add, add]) },
    { id: "late-retry", oracle: oracle([add, add, add]) },
    {
      id: "fifo-only",
      oracle: oracle([
        sendA,
        sendB,
        { type: "deliver", index: 1 },
        { type: "drop", index: 0 },
        add,
      ]),
    },
    {
      id: "drop-ignored",
      oracle: oracle([
        sendA,
        sendB,
        { type: "drop", index: 0 },
        { type: "deliver", index: 0 },
        { type: "add", id: "b", amount: 1 },
      ]),
    },
  ];
  for (const seed of seeds) {
    const corpus = generateCorpus(counterModel, "alternating", {
      seed,
      maxOperations: 128,
      maxDepth: 12,
    });
    for (const [index, actions] of corpus.cases.entries())
      cases.push({
        id: `seed-${seed}-${index}`,
        seed,
        oracle: oracle(actions),
      });
  }
  return {
    format: "modelt.oracle-suite",
    version: 1,
    model: compiled.model,
    faults: ["none", ...counterFaults],
    cases,
  };
};

export const parseSuite = (input: unknown): OracleSuite => {
  assert.ok(
    isRecord(input) &&
      input.format === "modelt.oracle-suite" &&
      input.version === 1,
    "Unsupported oracle suite",
  );
  assert.deepEqual(Object.keys(input).sort(), [
    "cases",
    "faults",
    "format",
    "model",
    "version",
  ]);
  const model = parseFiniteModel(input.model);
  assert.ok(
    Array.isArray(input.faults) && input.faults.length > 0,
    "Missing suite faults",
  );
  const faults = input.faults.map((fault: unknown) => {
    assert.ok(isFault(fault), "Unknown fault");
    return fault;
  });
  assert.ok(faults.includes("none") && new Set(faults).size === faults.length);
  assert.ok(
    Array.isArray(input.cases) && input.cases.length > 0,
    "Missing oracle cases",
  );
  const cases = input.cases.map((entry: unknown): OracleCase => {
    assert.ok(
      isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0,
      "Invalid oracle case",
    );
    assert.deepEqual(
      Object.keys(entry).sort(),
      entry.seed === undefined ? ["id", "oracle"] : ["id", "oracle", "seed"],
    );
    assert.ok(
      entry.seed === undefined ||
        (typeof entry.seed === "number" && Number.isSafeInteger(entry.seed)),
    );
    const trace = parsePortableTrace(entry.oracle);
    assert.equal(trace.model, model.name, "Oracle model differs");
    return {
      id: entry.id,
      oracle: trace,
      ...(typeof entry.seed === "number" ? { seed: entry.seed } : {}),
    };
  });
  assert.equal(
    new Set(cases.map((entry) => entry.id)).size,
    cases.length,
    "Duplicate case ID",
  );
  return { format: "modelt.oracle-suite", version: 1, model, faults, cases };
};
