import assert from "node:assert/strict";
import { test } from "node:test";
import { createPool } from "./pool.js";
import { executeScheduledBudget } from "./scheduler.js";
import { compileCounterTable, runTable } from "./table.js";

test("worker parallelism preserves results and respects an expired dispatch budget", async () => {
  const pool = await createPool(2);
  try {
    const options = {
      seed: 61,
      operations: 512,
      depth: 16,
      strategy: 1,
      repeats: 1,
      trace: false,
    };
    const jobs = [
      { kind: "kernel" as const, options },
      { kind: "kernel" as const, options: { ...options, seed: 62 } },
    ];
    const batch = await pool.run(jobs);
    assert.equal(batch.completed.length, 2);
    assert.equal(batch.remaining.length, 0);
    assert.deepEqual(
      batch.completed[0]?.result,
      runTable(compileCounterTable(), options),
    );
    const expired = await pool.run(jobs, performance.now() - 1);
    assert.equal(expired.completed.length, 0);
    assert.equal(expired.remaining.length, 2);
  } finally {
    await pool.close();
  }
});

test("budgeted schedule exploration never reports truncated depth as complete", async () => {
  const profile = {
    id: "inline-2",
    workload: "async-counter-2",
    workers: 1,
    startupMs: 0,
    visitsPerMs: 1000,
    fixedMemoryBytes: 1,
    bytesPerState: 64,
  };
  const budget = {
    workload: profile.workload,
    durationMs: 1000,
    memoryBytes: 1_000_000,
    maxWorkers: 1,
    maxDepth: 4,
    branching: 2,
  };
  const full = await executeScheduledBudget(2, budget, [profile]);
  await assert.rejects(
    executeScheduledBudget(2, { ...budget, workload: "counter-transitions" }, [
      profile,
    ]),
    /calibration/,
  );
  assert.equal(full.status, "violation");
  assert.equal(full.checked, 6);
  assert.equal(full.counterexamples.length, 4);
  assert.equal(full.coverageComplete, true);
  const shallow = await executeScheduledBudget(2, { ...budget, maxDepth: 3 }, [
    profile,
  ]);
  assert.equal(shallow.status, "budget-exhausted");
  assert.equal(shallow.coverageComplete, false);
  assert.equal(shallow.checked, 0);
  assert.equal(
    (await executeScheduledBudget(2, { ...budget, durationMs: 0 }, [profile]))
      .status,
    "budget-exhausted",
  );
});
