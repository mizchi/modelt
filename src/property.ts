import { type Arbitrary, asyncProperty, check, pre } from "fast-check";
import { checkConformance } from "./conformance.js";
import type {
  Comparison,
  ConformanceResult,
  Driver,
  Model,
} from "./contracts.js";

class PropertyMismatchError extends Error {}

export interface PropertyOptions<Observation> extends Comparison<Observation> {
  readonly seed?: number;
  readonly path?: string;
  readonly numRuns?: number;
  readonly maxSkipsPerRun?: number;
}

export interface PropertyResult<Action, Observation> {
  readonly status: "passed" | "failed" | "exhausted";
  readonly seed: number;
  readonly numRuns: number;
  readonly numShrinks: number;
  readonly numSkips: number;
  readonly path?: string;
  readonly counterexample?: readonly Action[];
  readonly failure?: ConformanceResult<Action, Observation>;
}

export const checkProperty = async <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  createDriver: () => Driver<Action, Observation>,
  actions: Arbitrary<readonly Action[]>,
  options: PropertyOptions<Observation> = {},
): Promise<PropertyResult<Action, Observation>> => {
  if (
    !Number.isSafeInteger(options.numRuns ?? 100) ||
    (options.numRuns ?? 100) < 1
  )
    throw new RangeError("numRuns must be a positive safe integer");
  const details = await check(
    asyncProperty(actions, async (sequence) => {
      const result = await checkConformance(
        model,
        createDriver(),
        sequence,
        options,
      );
      pre(result.status !== "invalid");
      if (result.status === "mismatch")
        throw new PropertyMismatchError(
          "Implementation diverged from the model",
        );
    }),
    {
      numRuns: options.numRuns ?? 100,
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.path === undefined ? {} : { path: options.path }),
      ...(options.maxSkipsPerRun === undefined
        ? {}
        : { maxSkipsPerRun: options.maxSkipsPerRun }),
    },
  );
  const statistics = {
    seed: details.seed,
    numRuns: details.numRuns,
    numShrinks: details.numShrinks,
    numSkips: details.numSkips,
  };
  if (!details.failed) return { ...statistics, status: "passed" };
  if (details.counterexample === null)
    return { ...statistics, status: "exhausted" };
  if (!(details.errorInstance instanceof PropertyMismatchError))
    throw details.errorInstance;
  const sequence = details.counterexample[0];
  const failure = await checkConformance(
    model,
    createDriver(),
    sequence,
    options,
  );
  if (failure.status !== "mismatch")
    throw new Error(
      "Counterexample did not reproduce; control the driver's nondeterminism",
    );
  return {
    ...statistics,
    status: "failed",
    counterexample: sequence,
    path: details.counterexamplePath,
    failure,
  };
};
