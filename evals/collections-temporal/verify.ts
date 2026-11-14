import assert from "node:assert/strict";
import { check } from "tla-ts";
import type { PortableCore, SafetyResult } from "../../src/contracts.js";
import { PortableCoreError } from "../../src/portable-value.js";
import { checkSafety } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import type { startNative } from "../usable/native.js";
import { bounds, type Case } from "./cases.js";
import { traceInput } from "./tlc.js";

interface Outcome {
  readonly result?: SafetyResult;
  readonly error?: { readonly code: string; readonly message: string };
}
export interface Report {
  readonly input: Case;
  readonly program: ReturnType<typeof compileTlaSafety>;
  readonly outcome: Outcome;
  readonly reference?: {
    readonly status: string;
    readonly states: number;
    readonly generated: number;
  };
  readonly witness?: {
    readonly source: string;
    readonly config: string;
    readonly states: number;
    readonly expected: "complete" | "liveness-violation";
  };
}
export const verify = async (
  input: Case,
  core: PortableCore,
  native: ReturnType<typeof startNative>,
): Promise<Report> => {
  const program = compileTlaSafety(input);
  let outcome: Outcome;
  try {
    outcome = { result: checkSafety(core, program, input.bounds ?? bounds) };
  } catch (error) {
    assert.ok(error instanceof PortableCoreError);
    outcome = { error: { code: error.code, message: error.message } };
  }
  const response = await native.request({
    version: 1,
    request: { kind: "check-safety", program, bounds: input.bounds ?? bounds },
  });
  assert.ok(isRecord(response));
  assert.deepEqual(
    response,
    outcome.result
      ? { kind: "safety", result: outcome.result }
      : { kind: "error", ...outcome.error },
  );
  assert.equal(outcome.result?.status ?? "error", input.expected, input.name);
  let reference: Report["reference"];
  if (!input.bounds && input.expected !== "empty") {
    const result = await check({ ...input, livenessCheck: "final" });
    reference = {
      status: result.status,
      states: result.distinctStates,
      generated: result.generatedStates,
    };
    assert.equal(
      result.status,
      input.expected === "complete"
        ? "success"
        : input.expected === "property-violation"
          ? "liveness-violation"
          : input.expected,
      input.name,
    );
    if (outcome.result?.status === "complete") {
      assert.equal(outcome.result.states, result.distinctStates);
      assert.equal(outcome.result.generated, result.generatedStates);
    }
  }
  let witness: Report["witness"];
  if (
    outcome.result?.violation?.trace.length &&
    outcome.result.status !== "deadlock"
  ) {
    const forced = traceInput(input, program, outcome.result);
    const result = await check({ ...forced, livenessCheck: "final" });
    assert.equal(
      result.status,
      forced.expected === "complete" ? "success" : forced.expected,
      `${input.name}: witness ${JSON.stringify(result)}`,
    );
    assert.equal(result.distinctStates, outcome.result.violation.trace.length);
    witness = { ...forced, states: result.distinctStates };
  }
  return {
    input,
    program,
    outcome,
    ...(reference ? { reference } : {}),
    ...(witness ? { witness } : {}),
  };
};
