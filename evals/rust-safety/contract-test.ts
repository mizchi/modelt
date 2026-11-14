import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { check } from "tla-ts";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety, decodeSafetyResult } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import { startNative } from "../usable/native.js";
import { bounds, cases } from "./cases.js";

test("Rust generates TLA states and checks safety in native and Wasm without a materialized graph", async () => {
  const core = await createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
  const native = startNative();
  try {
    for (const entry of cases) {
      const program = compileTlaSafety(entry);
      const limit = entry.bounds ?? bounds;
      const actual = await native.request({
        version: 1,
        request: { kind: "check-safety", program, bounds: limit },
      });
      assert.ok(isRecord(actual));
      if (entry.expected === "error") {
        assert.equal(actual.kind, "error", entry.name);
        assert.throws(
          () => checkSafety(core, program, limit),
          { name: "PortableCoreError" },
          entry.name,
        );
      } else {
        assert.equal(
          actual.kind,
          "safety",
          `${entry.name}: ${JSON.stringify(actual)}`,
        );
        const result = decodeSafetyResult(actual.result);
        assert.deepEqual(checkSafety(core, program, limit), result, entry.name);
        assert.equal(result.status, entry.expected, entry.name);
      }
      if (entry.bounds || entry.name === "empty") continue;
      const reference = await check(entry);
      assert.equal(
        reference.status,
        entry.expected === "complete" ? "success" : entry.expected,
        `${entry.name}: ${JSON.stringify(reference)}`,
      );
      if (entry.expected !== "error" && actual.kind === "safety") {
        const result = decodeSafetyResult(actual.result);
        assert.equal(result.states, reference.distinctStates, entry.name);
        assert.equal(result.generated, reference.generatedStates, entry.name);
        if (result.violation && reference.violation) {
          assert.deepEqual(
            result.violation.trace.map((step) =>
              Object.fromEntries(
                program.variables.map((name, index) => {
                  const value = step.values[index];
                  assert.ok(value);
                  return [
                    name,
                    value.type === "bool" ? value.value : Number(value.value),
                  ];
                }),
              ),
            ),
            reference.violation.trace.map((step) => step.state),
            entry.name,
          );
        }
      }
    }
  } finally {
    await native.close();
  }
});

test("the unmodified upstream DieHard model finds the same shortest solution", async () => {
  const source = await readFile("evals/fixtures/die-hard/DieHard.tla", "utf8");
  const core = await createPortableWasm(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  );
  for (const invariants of ["TypeOK", "TypeOK NotSolved"]) {
    const options = {
      source,
      config: `INIT Init\nNEXT Next\nINVARIANT ${invariants}`,
    };
    const actual = checkSafety(core, compileTlaSafety(options), bounds);
    const reference = await check(options);
    assert.equal(
      actual.status,
      reference.status === "success" ? "complete" : reference.status,
    );
    assert.equal(actual.states, reference.distinctStates);
    assert.equal(actual.generated, reference.generatedStates);
    if (actual.violation) {
      assert.equal(actual.violation.trace.length, 7);
      assert.deepEqual(
        actual.violation.trace.map((step) =>
          step.values.map((value) => Number(value.value)),
        ),
        reference.violation?.trace.map((step) => [
          step.state.big,
          step.state.small,
        ]),
      );
    }
  }
});
