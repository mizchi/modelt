import type { Driver } from "../src/index.js";
import type {
  CounterAction,
  CounterObservation,
  Request,
} from "./counter-model.js";

export {
  type CounterAction,
  type CounterObservation,
  counterModel,
} from "./counter-model.js";

export interface CounterOptions {
  readonly persist?: boolean;
  readonly deduplicate?: boolean;
}

export const createCounter = (
  options: CounterOptions = {},
): Driver<CounterAction, CounterObservation> => {
  let running = true;
  let value = 0;
  let durableValue = 0;
  let seen = new Set<string>();
  let durableSeen = new Set<string>();
  let pending: Request[] = [];
  const observe = (): CounterObservation => ({
    running,
    value: running ? value : 0,
  });
  const apply = (request: Request): void => {
    if (!running || (options.deduplicate !== false && seen.has(request.id)))
      return;
    value += request.amount;
    seen.add(request.id);
    if (options.persist !== false) {
      durableValue = value;
      durableSeen = new Set(seen);
    }
  };
  return {
    reset: () => {
      running = true;
      value = 0;
      durableValue = 0;
      seen.clear();
      durableSeen.clear();
      pending = [];
      return observe();
    },
    step: (action) => {
      switch (action.type) {
        case "add":
          apply(action);
          break;
        case "send":
          pending.push({ id: action.id, amount: action.amount });
          break;
        case "deliver": {
          const request = pending.splice(action.index, 1)[0];
          if (request) apply(request);
          break;
        }
        case "drop":
          pending.splice(action.index, 1);
          break;
        case "crash":
          running = false;
          value = 0;
          seen.clear();
          break;
        case "restart":
          if (running) break;
          running = true;
          value = durableValue;
          seen = new Set(durableSeen);
          break;
      }
      return observe();
    },
  };
};

export const isCounterAction = (value: unknown): value is CounterAction => {
  if (typeof value !== "object" || value === null || !("type" in value))
    return false;
  if (value.type === "crash" || value.type === "restart") return true;
  if (value.type === "deliver" || value.type === "drop")
    return (
      "index" in value &&
      typeof value.index === "number" &&
      Number.isSafeInteger(value.index) &&
      value.index >= 0
    );
  return (
    (value.type === "add" || value.type === "send") &&
    "id" in value &&
    typeof value.id === "string" &&
    "amount" in value &&
    typeof value.amount === "number" &&
    Number.isSafeInteger(value.amount)
  );
};

export const isCounterObservation = (
  value: unknown,
): value is CounterObservation =>
  typeof value === "object" &&
  value !== null &&
  "running" in value &&
  typeof value.running === "boolean" &&
  "value" in value &&
  typeof value.value === "number" &&
  Number.isSafeInteger(value.value);
