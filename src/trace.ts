import type { Trace } from "./contracts.js";

export class TraceFormatError extends Error {
  override readonly name = "TraceFormatError";
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const valueKey = (value: unknown): string => {
  const ancestors = new Set<object>();
  const visit = (current: unknown): string => {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return JSON.stringify(current);
    }
    if (typeof current === "number" && Number.isFinite(current))
      return JSON.stringify(current);
    if (
      typeof current !== "object" ||
      current === null ||
      ancestors.has(current)
    ) {
      throw new TraceFormatError(
        "Expected acyclic JSON values; encode bigint, sets and maps explicitly",
      );
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${Array.from(current, (item) => visit(item)).join(",")}]`;
      }
      if (
        Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null
      ) {
        throw new TraceFormatError("Expected a plain JSON object");
      }
      return `{${Object.entries(current)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${visit(item)}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(current);
    }
  };
  return visit(value);
};

export const equalValues = (expected: unknown, actual: unknown): boolean =>
  valueKey(expected) === valueKey(actual);

export interface TraceGuards<Action, Observation> {
  readonly action: (value: unknown) => value is Action;
  readonly observation: (value: unknown) => value is Observation;
}

export const encodeTrace = <Action, Observation>(
  trace: Trace<Action, Observation>,
): string => {
  valueKey(trace);
  return JSON.stringify(trace, null, 2);
};

export const decodeTrace = <Action, Observation>(
  text: string,
  guards: TraceGuards<Action, Observation>,
): Trace<Action, Observation> => {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.model !== "string" ||
    !guards.observation(value.initial) ||
    !Array.isArray(value.steps)
  ) {
    throw new TraceFormatError("Invalid trace header");
  }
  const steps = value.steps.map((step: unknown) => {
    if (
      !isRecord(step) ||
      !guards.action(step.action) ||
      !guards.observation(step.observation)
    ) {
      throw new TraceFormatError("Invalid trace step");
    }
    return { action: step.action, observation: step.observation };
  });
  return { version: 1, model: value.model, initial: value.initial, steps };
};
