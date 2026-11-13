import {
  type CounterAction,
  type CounterObservation,
  createCounter,
} from "../../examples/durable-counter.js";
import type { Driver } from "../../src/index.js";

export type CounterFault =
  | "none"
  | "persistence"
  | "deduplication"
  | "late-retry"
  | "fifo-only"
  | "drop-ignored";

export const counterFaults: readonly CounterFault[] = [
  "persistence",
  "deduplication",
  "late-retry",
  "fifo-only",
  "drop-ignored",
];

export const createFaultyCounter = (
  fault: CounterFault,
): Driver<CounterAction, CounterObservation> => {
  const implementation = createCounter({
    persist: fault !== "persistence",
    deduplicate: fault !== "deduplication",
  });
  const attempts = new Map<string, number>();
  let observation: CounterObservation = { running: true, value: 0 };
  return {
    reset: async () => {
      attempts.clear();
      observation = await implementation.reset();
      return observation;
    },
    step: async (action) => {
      if (fault === "drop-ignored" && action.type === "drop")
        return observation;
      if (fault === "fifo-only" && action.type === "deliver") {
        observation = await implementation.step({ ...action, index: 0 });
        return observation;
      }
      if (fault === "late-retry" && action.type === "add") {
        const count = (attempts.get(action.id) ?? 0) + 1;
        attempts.set(action.id, count);
        observation = await implementation.step(
          count === 3
            ? { ...action, id: `${action.id}:third-attempt` }
            : action,
        );
        return observation;
      }
      observation = await implementation.step(action);
      return observation;
    },
  };
};
