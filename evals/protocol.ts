import { isRecord } from "../src/trace.js";
import type { SearchStrategy } from "./harness/search.js";

export interface Method {
  readonly id: string;
  readonly strategy: SearchStrategy;
  readonly maxDepth: number;
}

export interface EvaluationPlan {
  readonly version: 1;
  readonly id: string;
  readonly scope: "synthetic-counter";
  readonly hypothesis: string;
  readonly change: string;
  readonly baseline: Method;
  readonly candidate: Method;
  readonly maxOperations: number;
  readonly developmentSeeds: readonly number[];
  readonly confirmationSeeds: readonly number[];
  readonly decisionRule: string;
  readonly limitations: string;
}

export class EvaluationProtocolError extends Error {
  override readonly name = "EvaluationProtocolError";
}

export const isRunId = (value: string): boolean =>
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

const parseMethod = (value: unknown): Method => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isRunId(value.id) ||
    (value.strategy !== "uniform" &&
      value.strategy !== "novelty" &&
      value.strategy !== "alternating") ||
    typeof value.maxDepth !== "number" ||
    !Number.isSafeInteger(value.maxDepth) ||
    value.maxDepth < 1
  )
    throw new EvaluationProtocolError("Invalid method");
  return { id: value.id, strategy: value.strategy, maxDepth: value.maxDepth };
};

const parseSeeds = (value: unknown): readonly number[] => {
  if (!Array.isArray(value) || value.length === 0)
    throw new EvaluationProtocolError("Empty seed split");
  const seeds = value.map((seed: unknown) => {
    if (
      typeof seed !== "number" ||
      !Number.isSafeInteger(seed) ||
      seed < 1 ||
      seed > 0xffff_ffff
    )
      throw new EvaluationProtocolError("Invalid seed");
    return seed;
  });
  if (new Set(seeds).size !== seeds.length)
    throw new EvaluationProtocolError("Duplicate seed");
  return seeds;
};

export const parsePlan = (value: unknown): EvaluationPlan => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !isRunId(value.id)
  )
    throw new EvaluationProtocolError("Invalid plan header");
  if (value.scope !== "synthetic-counter")
    throw new EvaluationProtocolError("Unsupported evaluation scope");
  if (
    typeof value.hypothesis !== "string" ||
    !value.hypothesis ||
    typeof value.change !== "string" ||
    !value.change ||
    typeof value.decisionRule !== "string" ||
    !value.decisionRule ||
    typeof value.limitations !== "string" ||
    !value.limitations
  )
    throw new EvaluationProtocolError("Missing plan rationale");
  if (
    typeof value.maxOperations !== "number" ||
    !Number.isSafeInteger(value.maxOperations) ||
    value.maxOperations < 2
  )
    throw new EvaluationProtocolError("Invalid operation budget");
  const baseline = parseMethod(value.baseline);
  const candidate = parseMethod(value.candidate);
  if (baseline.id === candidate.id)
    throw new EvaluationProtocolError("Method IDs must be distinct");
  const developmentSeeds = parseSeeds(value.developmentSeeds);
  const confirmationSeeds = parseSeeds(value.confirmationSeeds);
  if (confirmationSeeds.some((seed) => developmentSeeds.includes(seed)))
    throw new EvaluationProtocolError("Overlapping seed splits");
  return {
    version: 1,
    id: value.id,
    scope: value.scope,
    hypothesis: value.hypothesis,
    change: value.change,
    baseline,
    candidate,
    maxOperations: value.maxOperations,
    developmentSeeds,
    confirmationSeeds,
    decisionRule: value.decisionRule,
    limitations: value.limitations,
  };
};
