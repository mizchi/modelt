import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { check } from "tla-ts";
import type { PortableValue, SafetyResult } from "../../src/contracts.js";
import { PortableCoreError } from "../../src/portable-value.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import { bounds } from "../collections-temporal/cases.js";
import { traceInput } from "../collections-temporal/tlc.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { boundaries } from "./corpus.js";

interface Golden {
  readonly cases: readonly {
    name: string;
    sourceSha256: string;
    configSha256: string;
    log: string;
    logSha256: string;
    status: string;
    values: readonly PortableValue[];
  }[];
}
const golden: Golden = JSON.parse(
  await readFile("evals/fixtures/tlc-strings/expected.json", "utf8"),
);
const core = await createPortableWasm(
  await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  ),
);
for (const input of boundaries())
  test(`TLC regression: ${input.name}`, async () => {
    if (input.expectedRejection) {
      assert.throws(() => compileTlaSafety(input), /TLC 1.7.4 string literal/);
      return;
    }
    const fixture = golden.cases.find((entry) => entry.name === input.name);
    if (fixture) {
      assert.equal(fixture.sourceSha256, digest(input.source));
      assert.equal(fixture.configSha256, digest(input.config));
      assert.equal(
        fixture.logSha256,
        digest(await readFile(`evals/fixtures/tlc-strings/${fixture.log}`)),
      );
    }
    const reference =
      fixture ??
      (await check({
        source: input.source,
        config: input.config,
        livenessCheck: "final",
        version: "1.7.4",
      }));
    let result: SafetyResult | undefined;
    let error: PortableCoreError | undefined;
    try {
      result = checkSafety(core, compileTlaSafety(input), bounds);
    } catch (failure) {
      assert.ok(failure instanceof PortableCoreError);
      error = failure;
    }
    const status =
      result?.status === "complete" ? "success" : (result?.status ?? "error");
    assert.equal(
      status,
      reference.status,
      `${input.name}: ${JSON.stringify(result ?? error)}`,
    );
    const native = startNative();
    try {
      const response = await native.request({
        version: 1,
        request: {
          kind: "check-safety",
          program: compileTlaSafety(input),
          bounds,
        },
      });
      assert.ok(isRecord(response));
      assert.deepEqual(
        response,
        result
          ? { kind: "safety", result }
          : { kind: "error", code: error?.code, message: error?.message },
      );
    } finally {
      await native.close();
    }
    if (fixture)
      assert.deepEqual(result?.violation?.trace[0]?.values, fixture.values);
    if (result?.violation?.trace.length && !fixture) {
      const forced = traceInput(input, compileTlaSafety(input), result);
      const witness = await check({
        ...forced,
        version: "1.7.4",
        livenessCheck: "final",
      });
      assert.equal(witness.status, "success", input.name);
      assert.equal(witness.distinctStates, result.violation.trace.length);
    }
  });
