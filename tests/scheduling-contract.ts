import assert from "node:assert/strict";
import { planSchedule } from "../src/scheduling.js";

export const registerSchedulingContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  const jobs = [1, 9, 1, 9].map((estimatedMs, index) => ({
    id: `job-${index}`,
    estimatedMs,
    memoryBytes: 10,
  }));
  const profiles = [
    {
      id: "one",
      workers: 1,
      startupMs: 0,
      costScale: 1,
      fixedMemoryBytes: 100,
    },
    {
      id: "two",
      workers: 2,
      startupMs: 5,
      costScale: 1,
      fixedMemoryBytes: 200,
    },
    {
      id: "four",
      workers: 4,
      startupMs: 15,
      costScale: 1,
      fixedMemoryBytes: 400,
    },
  ];
  const budget = { durationMs: 30, memoryBytes: 1000, maxWorkers: 4 };
  const options = {
    policy: "cost" as const,
    batchTargetMs: 4,
    maxBatchSize: 16,
  };
  const firstJob = jobs[0];
  const firstProfile = profiles[0];
  assert.ok(firstJob && firstProfile);
  test("schedule chooses measured parallelism within time and memory budgets", () => {
    const plan = planSchedule(jobs, profiles, budget, options);
    assert.equal(plan.status, "planned");
    assert.equal(plan.workers, 2);
    assert.equal(plan.estimatedMs, 16);
    assert.equal(plan.estimatedMemoryBytes, 220);
    assert.equal(
      planSchedule(jobs, profiles, { ...budget, memoryBytes: 150 }, options)
        .workers,
      1,
    );
    assert.equal(
      planSchedule(jobs, profiles, { ...budget, durationMs: 14 }, options)
        .status,
      "insufficient-budget",
    );
    assert.equal(
      planSchedule(jobs, [], budget, options).status,
      "uncalibrated",
    );
    assert.equal(
      planSchedule(jobs, profiles, { ...budget, maxWorkers: 1 }, options)
        .workers,
      1,
    );
  });
  test("cost order batches small jobs while FIFO preserves input order", () => {
    const plan = planSchedule(jobs, profiles.slice(0, 1), budget, options);
    assert.deepEqual(plan.batches, [["job-1"], ["job-3"], ["job-0", "job-2"]]);
    assert.deepEqual(
      planSchedule(jobs, profiles, budget, { ...options, policy: "fifo" })
        .batches,
      jobs.map((job) => [job.id]),
    );
    assert.deepEqual(
      planSchedule(jobs, profiles, budget, { ...options, maxBatchSize: 1 })
        .batches,
      [["job-1"], ["job-3"], ["job-0"], ["job-2"]],
    );
    assert.deepEqual(
      jobs.map((job) => job.estimatedMs),
      [1, 9, 1, 9],
    );
  });
  test("scheduling rejects ambiguous identities and invalid resource estimates", () => {
    assert.throws(() =>
      planSchedule([firstJob, firstJob], profiles, budget, options),
    );
    for (const estimatedMs of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      assert.throws(() =>
        planSchedule(
          [{ id: "bad", estimatedMs, memoryBytes: 1 }],
          profiles,
          budget,
          options,
        ),
      );
    assert.throws(() =>
      planSchedule(jobs, profiles, { ...budget, durationMs: -1 }, options),
    );
    assert.throws(() =>
      planSchedule(jobs, profiles, budget, { ...options, maxBatchSize: 0 }),
    );
    assert.throws(() =>
      planSchedule(jobs, [{ ...firstProfile, costScale: 0 }], budget, options),
    );
    assert.equal(planSchedule([], profiles, budget, options).status, "empty");
  });
};
