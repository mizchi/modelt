import type {
  PortableCore,
  SafetyBounds,
  SafetyProgram,
  SafetyResult,
  SafetyScalar,
} from "./contracts.js";
import { normalizePortableValue, PortableCoreError } from "./portable-value.js";
import { isRecord } from "./trace.js";

export const decodeSafetyResult = (input: unknown): SafetyResult => {
  const fields = (value: unknown, keys: readonly string[]) => {
    if (
      !isRecord(value) ||
      Object.keys(value).sort().join() !== [...keys].sort().join()
    )
      throw new PortableCoreError("protocol", "Invalid safety result fields");
    return value;
  };
  const integer = (value: unknown): number => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 0xffff_ffff
    )
      throw new PortableCoreError("protocol", "Invalid safety result count");
    return value;
  };
  const value = fields(input, [
    "status",
    "reason",
    "states",
    "generated",
    "depth",
    "work",
    "violation",
  ]);
  if (
    (value.status !== "complete" &&
      value.status !== "bounded" &&
      value.status !== "empty" &&
      value.status !== "invariant-violation" &&
      value.status !== "deadlock" &&
      value.status !== "assumption-violation") ||
    (value.reason !== null &&
      value.reason !== "depth" &&
      value.reason !== "states" &&
      value.reason !== "work") ||
    (value.status === "bounded") !== (value.reason !== null)
  )
    throw new PortableCoreError("protocol", "Invalid safety status");
  const violation =
    value.violation === null
      ? null
      : fields(value.violation, ["name", "trace"]);
  if (
    (violation &&
      (typeof violation.name !== "string" ||
        !Array.isArray(violation.trace))) ||
    (value.status === "invariant-violation" ||
      value.status === "deadlock" ||
      value.status === "assumption-violation") !==
      (violation !== null)
  )
    throw new PortableCoreError("protocol", "Invalid safety violation");
  const trace =
    violation === null
      ? []
      : (Array.isArray(violation.trace) ? violation.trace : []).map(
          (entry: unknown) => {
            const step = fields(entry, ["action", "values"]);
            if (
              (step.action !== null && typeof step.action !== "string") ||
              !Array.isArray(step.values)
            )
              throw new PortableCoreError("protocol", "Invalid safety trace");
            return {
              action: step.action,
              values: step.values.map((entry: unknown): SafetyScalar => {
                const scalar = normalizePortableValue(entry);
                if (scalar.type !== "int" && scalar.type !== "bool")
                  throw new PortableCoreError(
                    "protocol",
                    "Invalid safety scalar",
                  );
                return scalar.type === "bool"
                  ? scalar
                  : { type: "int", value: scalar.value };
              }),
            };
          },
        );
  return {
    status: value.status,
    reason: value.reason,
    states: integer(value.states),
    generated: integer(value.generated),
    depth: integer(value.depth),
    work: integer(value.work),
    violation:
      violation === null ? null : { name: String(violation.name), trace },
  };
};

export const checkSafety = (
  core: PortableCore,
  program: SafetyProgram,
  bounds: SafetyBounds,
): SafetyResult => {
  const output = core.request({
    version: 1,
    request: { kind: "check-safety", program, bounds },
  });
  if (output.kind !== "safety")
    throw new PortableCoreError("protocol", "Expected a safety result");
  return output.result;
};

export type { SafetyBounds, SafetyProgram, SafetyResult } from "./contracts.js";
