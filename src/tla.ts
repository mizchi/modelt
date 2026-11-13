import {
  type CheckOptions,
  type CheckResult,
  check,
  type TraceStep,
} from "tla-ts";
import type { Trace } from "./contracts.js";

export interface TlaMapping<Action, Observation> {
  readonly name: string;
  readonly observation: (step: TraceStep) => Observation;
  readonly action: (
    step: TraceStep,
    previous: TraceStep,
    index: number,
  ) => Action;
}

export interface TlaOracle<Action, Observation> {
  readonly check: CheckResult;
  readonly trace?: Trace<Action, Observation>;
}

export const generateTlaOracle = async <Action, Observation>(
  options: CheckOptions,
  mapping: TlaMapping<Action, Observation>,
): Promise<TlaOracle<Action, Observation>> => {
  const result = await check(options);
  const violation = result.violation;
  const initial = violation?.trace[0];
  if (
    !initial ||
    !violation ||
    violation.loopStart !== undefined ||
    result.failure ||
    result.status === "error"
  )
    return { check: result };
  const steps = violation.trace.slice(1).map((step, index) => {
    const previous = violation.trace[index];
    if (!previous) throw new Error("TLA trace is missing its preceding state");
    return {
      action: mapping.action(step, previous, index),
      observation: mapping.observation(step),
    };
  });
  return {
    check: result,
    trace: {
      version: 1,
      model: mapping.name,
      initial: mapping.observation(initial),
      steps,
    },
  };
};
