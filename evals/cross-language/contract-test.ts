import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { executeSuite } from "./runners.js";
import { buildSuite, parseSuite } from "./suite.js";

test("the same oracle drives live TS, Rust and Go implementations", async () => {
  const suite = buildSuite([201]);
  const result = await executeSuite(suite);
  assert.equal(result.languages, 3);
  assert.equal(result.normalControls, suite.cases.length * 3 * 2);
  assert.equal(result.comparisons, suite.cases.length * 6 * 2 * 2);
  for (const [fault, id, step] of [
    ["persistence", "persistence", 3],
    ["deduplication", "deduplication", 2],
    ["late-retry", "late-retry", 3],
    ["fifo-only", "fifo-only", 5],
    ["drop-ignored", "drop-ignored", 5],
  ] as const) {
    const row = result.rows.find(
      (entry) => entry.caseId === id && entry.fault === fault,
    );
    assert.ok(row);
    assert.equal(row.result.status, "mismatch");
    assert.equal(row.result.checkedSteps, step);
  }
});

test("a changed expected observation is rejected before live execution", async () => {
  const suite = buildSuite([]);
  const first = suite.cases[0];
  assert.ok(first);
  const changed = {
    ...suite,
    cases: [
      {
        ...first,
        oracle: { ...first.oracle, initial: { type: "int", value: "99" } },
      },
    ],
  };
  await assert.rejects(executeSuite(parseSuite(changed)), /oracle/i);
  for (const [command, arguments_] of [
    ["evals/shared-oracle-rust/target/release/modelt-shared-oracle", []],
    [
      ".artifacts/go/counter-replay",
      [
        "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
      ],
    ],
  ] as const) {
    const result = spawnSync(command, [...arguments_], {
      input: JSON.stringify(changed),
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr.toString(), /oracle/i);
  }
  assert.throws(() => parseSuite({ ...suite, version: 2 }), /suite/i);
  assert.throws(() => parseSuite({ ...suite, cases: [] }), /cases/i);
});
