import type { SafetyResult } from "../../src/contracts.js";
import type { runTlc } from "../collections-temporal/tlc.js";
export interface Observation {
  readonly result?: SafetyResult;
  readonly error?: {
    readonly phase: "compile" | "check";
    readonly code: string;
    readonly message: string;
  };
}
export const classifyTlc = (
  reference: Awaited<ReturnType<typeof runTlc>>,
): string => {
  if (reference.exit === null || !reference.log.includes("TLC2 Version"))
    return "infrastructure-error";
  if (
    /^java\.lang\.(NullPointerException|OutOfMemoryError|NoClassDefFoundError)/m.test(
      reference.log,
    )
  )
    return "infrastructure-error";
  if (
    /Semantic errors|Lexical error|Parsing or semantic analysis failed|Fatal errors/.test(
      reference.log,
    )
  )
    return "input-error";
  if (reference.status === "error")
    return reference.log.includes("Starting...") &&
      reference.log.includes("Error:")
      ? "model-error"
      : "infrastructure-error";
  if (
    ["complete", "empty"].includes(reference.status) &&
    (reference.states === null || reference.generated === null)
  )
    return "infrastructure-error";
  return reference.status;
};
export const differences = (
  ours: Observation,
  reference: Awaited<ReturnType<typeof runTlc>>,
): readonly string[] => {
  const actual = ours.error
    ? ours.error.phase === "compile"
      ? "unsupported"
      : "model-error"
    : ours.result?.status === "property-violation"
      ? "liveness-violation"
      : ours.result?.status;
  const expected = classifyTlc(reference);
  if (expected === "infrastructure-error") return ["infrastructure-error"];
  if (actual === "unsupported" || actual === "bounded") return [String(actual)];
  if (actual !== expected) return [`verdict: ${actual} != ${expected}`];
  if (!ours.result) return [];
  const result: string[] = [];
  if (reference.states !== null && ours.result.states !== reference.states)
    result.push(`states: ${ours.result.states} != ${reference.states}`);
  if (
    reference.generated !== null &&
    ours.result.generated !== reference.generated
  )
    result.push(
      `generated: ${ours.result.generated} != ${reference.generated}`,
    );
  if (
    ours.result.violation &&
    ["invariant-violation", "property-violation", "deadlock"].includes(
      ours.result.status,
    )
  ) {
    const length = /violated by the initial state/.test(reference.log)
      ? 1
      : [...reference.log.matchAll(/^State \d+:/gm)].length;
    if (length !== ours.result.violation.trace.length)
      result.push(
        `trace-length: ${ours.result.violation.trace.length} != ${length}`,
      );
  }
  return result;
};
