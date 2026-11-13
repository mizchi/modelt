import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { array, constantFrom, integer } from "fast-check";
import { init, killThreads } from "z3-solver";
import {
  type CounterAction,
  type CounterObservation,
  counterModel,
} from "../../examples/durable-counter.js";
import {
  type ConformanceResult,
  checkConformance,
  checkModel,
  checkTrace,
} from "../../src/index.js";
import { checkProperty } from "../../src/property.js";
import { createSmtOracle } from "../../src/smt.js";
import {
  type CounterFault,
  counterFaults,
  createFaultyCounter,
} from "./counter-faults.js";
import { checkHistory, incrementHistoryModel } from "./history.js";
import { interleavings, runScheduledCounter } from "./scheduled-counter.js";
import {
  enabledActions,
  generateCorpus,
  type SearchStrategy,
} from "./search.js";
import { createTtlDriver, type TtlAction, ttlModel } from "./ttl.js";

interface Trial {
  readonly seed: number;
  readonly strategy: SearchStrategy;
  readonly fault: CounterFault;
  readonly cases: number;
  readonly operations: number;
  readonly modelSteps: number;
  readonly states: number;
  readonly edges: number;
  readonly generationMs: number;
  readonly executionMs: number;
  readonly invalid: number;
  readonly detected: boolean;
  readonly firstFailureOperations: number | null;
  readonly replayed: boolean | null;
  readonly fixedPassed: boolean | null;
}

interface PropertyTrial {
  readonly generator: "raw" | "enabled";
  readonly seed: number;
  readonly fault: CounterFault;
  readonly status: "passed" | "failed" | "exhausted";
  readonly numRuns: number;
  readonly numShrinks: number;
  readonly numSkips: number;
  readonly cases: number;
  readonly operations: number;
  readonly executionMs: number;
  readonly path: string | null;
  readonly counterexample: readonly CounterAction[] | null;
  readonly replayed: boolean | null;
  readonly fixedPassed: boolean | null;
}

const seeds = Array.from({ length: 20 }, (_, index) => index + 1);
const budget = { maxOperations: 512, maxDepth: 8 };
const trials: Trial[] = [];
const witnesses = new Map<
  string,
  ConformanceResult<CounterAction, CounterObservation>
>();
const target = process.argv[2] ?? ".artifacts/evaluation";
const median = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return (
    ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) +
      (sorted[Math.floor(sorted.length / 2)] ?? 0)) /
    2
  );
};

for (const seed of seeds) {
  for (const strategy of ["uniform", "novelty"] as const) {
    const generationStart = performance.now();
    const corpus = generateCorpus(counterModel, strategy, { ...budget, seed });
    const generationMs = performance.now() - generationStart;
    for (const fault of ["none", ...counterFaults] as const) {
      let operations = 0;
      let invalid = 0;
      let first:
        | ConformanceResult<CounterAction, CounterObservation>
        | undefined;
      let firstActions: readonly CounterAction[] | undefined;
      let firstFailureOperations: number | null = null;
      const executionStart = performance.now();
      for (const actions of corpus.cases) {
        const result = await checkConformance(
          counterModel,
          createFaultyCounter(fault),
          actions,
        );
        operations += 1 + result.checkedSteps;
        if (result.status === "invalid") invalid++;
        if (result.status === "mismatch" && !first) {
          first = result;
          firstActions = actions;
          firstFailureOperations = operations;
        }
      }
      const executionMs = performance.now() - executionStart;
      const replayed = firstActions
        ? (
            await checkConformance(
              counterModel,
              createFaultyCounter(fault),
              firstActions,
            )
          ).status === "mismatch"
        : null;
      const fixedPassed = firstActions
        ? (
            await checkConformance(
              counterModel,
              createFaultyCounter("none"),
              firstActions,
            )
          ).status === "matched"
        : null;
      if (first && !witnesses.has(fault)) witnesses.set(fault, first);
      trials.push({
        seed,
        strategy,
        fault,
        cases: corpus.cases.length,
        operations,
        modelSteps: corpus.modelSteps,
        states: corpus.states,
        edges: corpus.edges,
        generationMs,
        executionMs,
        invalid,
        detected: first !== undefined,
        firstFailureOperations,
        replayed,
        fixedPassed,
      });
    }
  }
}

const comparison = counterFaults.map((fault) => {
  const uniform = trials.filter(
    (trial) => trial.fault === fault && trial.strategy === "uniform",
  );
  const novelty = trials.filter(
    (trial) => trial.fault === fault && trial.strategy === "novelty",
  );
  const pairs = seeds.map((seed) => ({
    uniform: uniform.find((trial) => trial.seed === seed)?.detected ?? false,
    novelty: novelty.find((trial) => trial.seed === seed)?.detected ?? false,
  }));
  return {
    fault,
    uniform: uniform.filter((trial) => trial.detected).length,
    novelty: novelty.filter((trial) => trial.detected).length,
    uniformOnly: pairs.filter((pair) => pair.uniform && !pair.novelty).length,
    noveltyOnly: pairs.filter((pair) => !pair.uniform && pair.novelty).length,
    both: pairs.filter((pair) => pair.uniform && pair.novelty).length,
    neither: pairs.filter((pair) => !pair.uniform && !pair.novelty).length,
    uniformMedianOperationsWhenDetected: median(
      uniform.flatMap((trial) =>
        trial.firstFailureOperations === null
          ? []
          : [trial.firstFailureOperations],
      ),
    ),
    noveltyMedianOperationsWhenDetected: median(
      novelty.flatMap((trial) =>
        trial.firstFailureOperations === null
          ? []
          : [trial.firstFailureOperations],
      ),
    ),
  };
});

const oracle = checkModel(counterModel, { maxDepth: 12, maxStates: 1000 });
const bfs = [];
for (const fault of ["none", ...counterFaults] as const) {
  let detected = false;
  let operations = 0;
  for (const trace of oracle.traces) {
    const result = await checkTrace(trace, createFaultyCounter(fault));
    operations += 1 + result.checkedSteps;
    if (result.status === "mismatch") detected = true;
  }
  bfs.push({ fault, detected, operations });
}

const arbitrary = array(
  constantFrom<CounterAction>(
    { type: "add", id: "a", amount: 1 },
    { type: "add", id: "b", amount: 1 },
    { type: "send", id: "a", amount: 1 },
    { type: "send", id: "b", amount: 1 },
    { type: "deliver", index: 0 },
    { type: "deliver", index: 1 },
    { type: "drop", index: 0 },
    { type: "drop", index: 1 },
    { type: "crash" },
    { type: "restart" },
  ),
  { maxLength: 8 },
);
const properties: PropertyTrial[] = [];
const generators = [
  { name: "raw" as const, actions: arbitrary },
  {
    name: "enabled" as const,
    actions: array(integer({ min: 0, max: 65535 }), { maxLength: 8 }).map(
      (choices) => enabledActions(counterModel, choices),
    ),
  },
];
for (const generator of generators) {
  for (const seed of seeds) {
    for (const fault of ["none", ...counterFaults] as const) {
      let operations = 0;
      let cases = 0;
      const start = performance.now();
      const result = await checkProperty(
        counterModel,
        () => {
          const driver = createFaultyCounter(fault);
          return {
            reset: () => {
              operations++;
              cases++;
              return driver.reset();
            },
            step: (action: CounterAction) => {
              operations++;
              return driver.step(action);
            },
          };
        },
        generator.actions,
        { seed, numRuns: 64 },
      );
      const executionMs = performance.now() - start;
      const replayed = result.counterexample
        ? (
            await checkConformance(
              counterModel,
              createFaultyCounter(fault),
              result.counterexample,
            )
          ).status === "mismatch"
        : null;
      const fixedPassed = result.counterexample
        ? (
            await checkConformance(
              counterModel,
              createFaultyCounter("none"),
              result.counterexample,
            )
          ).status === "matched"
        : null;
      properties.push({
        generator: generator.name,
        seed,
        fault,
        status: result.status,
        numRuns: result.numRuns,
        numShrinks: result.numShrinks,
        numSkips: result.numSkips,
        cases,
        operations,
        executionMs,
        path: result.path ?? null,
        counterexample: result.counterexample ?? null,
        replayed,
        fixedPassed,
      });
    }
  }
}

const schedules = [];
const sequential = await runScheduledCounter(true, [1, 2, 3, 4], "sequential");
for (const ordering of interleavings) {
  const broken = await runScheduledCounter(true, ordering);
  const fixed = await runScheduledCounter(false, ordering);
  const replayed = await runScheduledCounter(true, broken.ordering);
  schedules.push({
    ...broken,
    broken: checkHistory(incrementHistoryModel, broken.history, 100),
    fixed: checkHistory(incrementHistoryModel, fixed.history, 100),
    replayed: JSON.stringify(broken) === JSON.stringify(replayed),
  });
}

const boundaryActions: readonly TtlAction[] = [
  { type: "put", ttl: 1 },
  { type: "advance", amount: 1 },
  { type: "read" },
];
const boundaryStart = performance.now();
const boundaryBroken = await checkConformance(
  ttlModel,
  createTtlDriver(true),
  boundaryActions,
);
const boundaryFixed = await checkConformance(
  ttlModel,
  createTtlDriver(false),
  boundaryActions,
);
const boundaryMs = performance.now() - boundaryStart;
const withoutClock = await checkConformance(ttlModel, createTtlDriver(true), [
  { type: "put", ttl: 1 },
  { type: "read" },
]);
const initStart = performance.now();
const api = await init();
const initializationMs = performance.now() - initStart;
const smt = await (async () => {
  try {
    const start = performance.now();
    const result = await createSmtOracle(api).solve(
      "(set-logic QF_LIA) (declare-const ttl Int) (declare-const elapsed Int) (assert (and (>= ttl 1) (<= ttl 10000) (>= elapsed 0) (<= elapsed 20000) (= elapsed ttl)))",
      ["ttl", "elapsed"],
    );
    const solveMs = performance.now() - start;
    if (result.status !== "sat")
      throw new Error(`Expiry constraint was ${result.status}`);
    const actions: readonly TtlAction[] = [
      { type: "put", ttl: Number(result.values.ttl) },
      { type: "advance", amount: Number(result.values.elapsed) },
      { type: "read" },
    ];
    return {
      values: result.values,
      solveMs,
      broken: (await checkConformance(ttlModel, createTtlDriver(true), actions))
        .status,
      fixed: (await checkConformance(ttlModel, createTtlDriver(false), actions))
        .status,
    };
  } finally {
    await killThreads(api.em);
  }
})();

const summaries = (["uniform", "novelty"] as const).map((strategy) => {
  const healthy = trials.filter(
    (trial) => trial.strategy === strategy && trial.fault === "none",
  );
  return {
    strategy,
    falsePositives: healthy.filter((trial) => trial.detected).length,
    medianStates: median(healthy.map((trial) => trial.states)),
    medianEdges: median(healthy.map((trial) => trial.edges)),
    medianCases: median(healthy.map((trial) => trial.cases)),
    medianModelSteps: median(healthy.map((trial) => trial.modelSteps)),
    medianOperations: median(healthy.map((trial) => trial.operations)),
    medianGenerationMs: median(healthy.map((trial) => trial.generationMs)),
    medianExecutionMs: median(healthy.map((trial) => trial.executionMs)),
  };
});
const summary = {
  version: 1,
  date: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  seeds,
  budget,
  scope:
    "Seeded synthetic faults; not unknown production bugs. Wall-clock timings are descriptive, not performance claims.",
  search: {
    summaries,
    comparison,
    invalid: trials.reduce((total, trial) => total + trial.invalid, 0),
    replayFailures: trials.filter(
      (trial) => trial.replayed === false || trial.fixedPassed === false,
    ).length,
  },
  bfs: {
    status: oracle.status,
    states: oracle.states,
    edges: oracle.edges,
    traces: oracle.traces.length,
    results: bfs,
  },
  pbt: generators.flatMap((generator) =>
    ["none", ...counterFaults].map((fault) => {
      const records = properties.filter(
        (record) =>
          record.fault === fault && record.generator === generator.name,
      );
      return {
        generator: generator.name,
        fault,
        detected: records.filter((record) => record.status === "failed").length,
        exhausted: records.filter((record) => record.status === "exhausted")
          .length,
        medianCases: median(records.map((record) => record.cases)),
        medianOperations: median(records.map((record) => record.operations)),
        medianSkips: median(records.map((record) => record.numSkips)),
        medianShrunkLengthWhenDetected: median(
          records.flatMap((record) =>
            record.counterexample ? [record.counterexample.length] : [],
          ),
        ),
        replayFailures: records.filter(
          (record) => record.replayed === false || record.fixedPassed === false,
        ).length,
      };
    }),
  ),
  concurrency: {
    sequentialBroken: checkHistory(
      incrementHistoryModel,
      sequential.history,
      100,
    ).status,
    schedules: schedules.length,
    rejectedBroken: schedules.filter(
      (record) => record.broken.status === "not-linearizable",
    ).length,
    rejectedFixed: schedules.filter(
      (record) => record.fixed.status !== "linearizable",
    ).length,
    replayFailures: schedules.filter((record) => !record.replayed).length,
  },
  time: {
    withoutClock: withoutClock.status,
    boundary: {
      broken: boundaryBroken.status,
      fixed: boundaryFixed.status,
      executionMs: boundaryMs,
    },
    smt: { initializationMs, ...smt },
  },
};
if (
  summary.search.invalid > 0 ||
  summary.search.replayFailures > 0 ||
  summaries.some((record) => record.falsePositives > 0) ||
  summary.pbt.some(
    (record) =>
      record.replayFailures > 0 ||
      (record.fault === "none" && record.detected > 0),
  ) ||
  summary.concurrency.rejectedFixed > 0 ||
  summary.concurrency.replayFailures > 0 ||
  summary.bfs.results.some(
    (record) => record.fault === "none" && record.detected,
  ) ||
  summary.time.boundary.fixed !== "matched" ||
  summary.time.smt.fixed !== "matched"
)
  throw new Error(
    "Evaluation controls failed; do not interpret the measurements",
  );
await mkdir(target, { recursive: true });
await writeFile(
  join(target, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
await writeFile(
  join(target, "witnesses.json"),
  `${JSON.stringify({ search: Object.fromEntries(witnesses), sequential, schedules, ttl: boundaryBroken }, null, 2)}\n`,
);
await writeFile(
  join(target, "pbt.json"),
  `${JSON.stringify(properties, null, 2)}\n`,
);
const propertyColumns: readonly (keyof PropertyTrial)[] = [
  "generator",
  "seed",
  "fault",
  "status",
  "numRuns",
  "numShrinks",
  "numSkips",
  "cases",
  "operations",
  "executionMs",
  "path",
  "counterexample",
  "replayed",
  "fixedPassed",
];
await writeFile(
  join(target, "pbt.csv"),
  `${propertyColumns.join(",")}\n${properties.map((record) => propertyColumns.map((column) => `"${String(column === "counterexample" ? JSON.stringify(record.counterexample) : (record[column] ?? "")).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`,
);
const columns: readonly (keyof Trial)[] = [
  "seed",
  "strategy",
  "fault",
  "cases",
  "operations",
  "modelSteps",
  "states",
  "edges",
  "generationMs",
  "executionMs",
  "invalid",
  "detected",
  "firstFailureOperations",
  "replayed",
  "fixedPassed",
];
await writeFile(
  join(target, "search.csv"),
  `${columns.join(",")}\n${trials.map((trial) => columns.map((column) => trial[column] ?? "").join(",")).join("\n")}\n`,
);
console.log(JSON.stringify(summary, null, 2));
console.log(`Evidence written to ${target}`);
