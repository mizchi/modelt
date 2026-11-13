import {
  type CounterAction,
  type CounterObservation,
  counterModel,
} from "../examples/durable-counter.js";
import { type ConformanceResult, checkConformance } from "../src/index.js";
import {
  counterFaults,
  createFaultyCounter,
} from "./harness/counter-faults.js";
import { generateCorpus } from "./harness/search.js";
import { type EvaluationPlan, EvaluationProtocolError } from "./protocol.js";

export interface Trial {
  readonly seed: number;
  readonly method: string;
  readonly fault: string;
  readonly detected: boolean;
  readonly invalid: number;
  readonly operations: number;
  readonly resets: number;
  readonly elapsedMs: number;
  readonly firstFailureOperations: number | null;
  readonly firstFailureLength: number | null;
  readonly replayed: boolean | null;
  readonly fixedPassed: boolean | null;
}

const median = (values: readonly number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return (
    ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) +
      (sorted[Math.floor(sorted.length / 2)] ?? 0)) /
    2
  );
};

export const compareTrials = (
  trials: readonly Trial[],
  baseline: string,
  candidate: string,
) => {
  const keys = new Set<string>();
  const seeds = new Set(trials.map((trial) => trial.seed));
  const faults = [
    ...new Set(
      trials
        .filter((trial) => trial.fault !== "none")
        .map((trial) => trial.fault),
    ),
  ].sort();
  if (faults.length === 0 || seeds.size === 0 || baseline === candidate)
    throw new EvaluationProtocolError("Missing comparison data");
  for (const trial of trials) {
    const key = JSON.stringify([trial.seed, trial.method, trial.fault]);
    if (keys.has(key)) throw new EvaluationProtocolError("Duplicate trial");
    keys.add(key);
  }
  const get = (seed: number, method: string, fault: string) => {
    const trial = trials.find(
      (entry) =>
        entry.seed === seed && entry.method === method && entry.fault === fault,
    );
    if (!trial)
      throw new EvaluationProtocolError(
        fault === "none" ? "Missing normal control" : "Missing paired trial",
      );
    return trial;
  };
  for (const seed of seeds)
    for (const method of [baseline, candidate])
      for (const fault of ["none", ...faults]) get(seed, method, fault);
  const controlFailures = trials
    .filter(
      (trial) =>
        trial.invalid > 0 ||
        (trial.fault === "none" && trial.detected) ||
        (trial.detected &&
          (trial.replayed !== true || trial.fixedPassed !== true)),
    )
    .map((trial) => ({
      seed: trial.seed,
      method: trial.method,
      fault: trial.fault,
    }));
  const comparisons = faults.map((fault) => {
    const pairs = [...seeds].map((seed) => ({
      baseline: get(seed, baseline, fault),
      candidate: get(seed, candidate, fault),
    }));
    return {
      fault,
      baselineDetected: pairs.filter((pair) => pair.baseline.detected).length,
      candidateDetected: pairs.filter((pair) => pair.candidate.detected).length,
      candidateOnly: pairs
        .filter((pair) => !pair.baseline.detected && pair.candidate.detected)
        .map((pair) => pair.candidate.seed),
      baselineOnly: pairs
        .filter((pair) => pair.baseline.detected && !pair.candidate.detected)
        .map((pair) => pair.baseline.seed),
      baselineMedianFirstFailureOperations: median(
        pairs.flatMap((pair) =>
          pair.baseline.firstFailureOperations === null
            ? []
            : [pair.baseline.firstFailureOperations],
        ),
      ),
      candidateMedianFirstFailureOperations: median(
        pairs.flatMap((pair) =>
          pair.candidate.firstFailureOperations === null
            ? []
            : [pair.candidate.firstFailureOperations],
        ),
      ),
      baselineMedianFailureLength: median(
        pairs.flatMap((pair) =>
          pair.baseline.firstFailureLength === null
            ? []
            : [pair.baseline.firstFailureLength],
        ),
      ),
      candidateMedianFailureLength: median(
        pairs.flatMap((pair) =>
          pair.candidate.firstFailureLength === null
            ? []
            : [pair.candidate.firstFailureLength],
        ),
      ),
    };
  });
  const improvements = comparisons.filter(
    (row) => row.candidateDetected > row.baselineDetected,
  ).length;
  const regressions = comparisons.filter(
    (row) => row.candidateDetected < row.baselineDetected,
  ).length;
  const assessment =
    controlFailures.length > 0
      ? "controls-failed"
      : improvements > 0 && regressions > 0
        ? "mixed"
        : regressions > 0
          ? "regressed"
          : improvements > 0
            ? "improved"
            : "unchanged";
  return {
    assessment,
    controlFailures,
    comparisons,
    controls: [baseline, candidate].map((method) => {
      const rows = trials.filter(
        (trial) => trial.method === method && trial.fault === "none",
      );
      return {
        method,
        trials: rows.length,
        medianOperations: median(rows.map((row) => row.operations)),
        medianResets: median(rows.map((row) => row.resets)),
        medianElapsedMs: median(rows.map((row) => row.elapsedMs)),
      };
    }),
  };
};

export const benchmark = async (
  plan: EvaluationPlan,
  seeds: readonly number[],
) => {
  const trials: Trial[] = [];
  const corpora = [];
  const witnesses = new Map<
    string,
    ConformanceResult<CounterAction, CounterObservation>
  >();
  for (const seed of seeds) {
    for (const method of [plan.baseline, plan.candidate]) {
      const generationStart = performance.now();
      const corpus = generateCorpus(counterModel, method.strategy, {
        seed,
        maxDepth: method.maxDepth,
        maxOperations: plan.maxOperations,
      });
      corpora.push({
        seed,
        method: method.id,
        generationMs: performance.now() - generationStart,
        cases: corpus.cases.length,
        requestedOperations: corpus.operations,
        modelSteps: corpus.modelSteps,
        states: corpus.states,
        edges: corpus.edges,
      });
      for (const fault of ["none", ...counterFaults] as const) {
        let operations = 0;
        let invalid = 0;
        let firstFailureOperations: number | null = null;
        let first:
          | ConformanceResult<CounterAction, CounterObservation>
          | undefined;
        const start = performance.now();
        for (const actions of corpus.cases) {
          const result = await checkConformance(
            counterModel,
            createFaultyCounter(fault),
            actions,
          );
          operations += result.checkedSteps + 1;
          if (result.status === "invalid") invalid++;
          if (result.status === "mismatch" && !first) {
            first = result;
            firstFailureOperations = operations;
          }
        }
        const elapsedMs = performance.now() - start;
        const firstActions = first?.trace.steps.map((step) => step.action);
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
        trials.push({
          seed,
          method: method.id,
          fault,
          operations,
          invalid,
          resets: corpus.cases.length,
          elapsedMs,
          detected: first !== undefined,
          firstFailureOperations,
          firstFailureLength: first?.checkedSteps ?? null,
          replayed,
          fixedPassed,
        });
        if (first && !witnesses.has(`${method.id}/${fault}`))
          witnesses.set(`${method.id}/${fault}`, first);
      }
    }
  }
  return {
    trials,
    corpora,
    witnesses: Object.fromEntries(witnesses),
    comparison: compareTrials(trials, plan.baseline.id, plan.candidate.id),
  };
};
