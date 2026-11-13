import assert from "node:assert/strict";
import { enumerateSchedules } from "../evals/runtime/schedules.js";
import {
  compileCounterTable,
  runDynamic,
  runTable,
} from "../evals/runtime/table.js";
import { planBudget } from "../src/budget.js";

export const registerBudgetContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  const profiles = [
    {
      id: "serial",
      workload: "test",
      workers: 1,
      startupMs: 0,
      visitsPerMs: 10,
      fixedMemoryBytes: 100,
      bytesPerState: 10,
    },
    {
      id: "pool",
      workload: "test",
      workers: 4,
      startupMs: 30,
      visitsPerMs: 40,
      fixedMemoryBytes: 400,
      bytesPerState: 10,
    },
  ];
  test("time and memory budgets choose a feasible worker count and depth", () => {
    const short = planBudget(
      {
        workload: "test",
        durationMs: 10,
        memoryBytes: 100000,
        maxWorkers: 4,
        maxDepth: 20,
        branching: 2,
      },
      profiles,
    );
    assert.equal(short.status, "planned");
    assert.equal(short.workers, 1);
    assert.equal(short.maxDepth, 5);
    const long = planBudget(
      {
        workload: "test",
        durationMs: 100,
        memoryBytes: 100000,
        maxWorkers: 4,
        maxDepth: 20,
        branching: 2,
      },
      profiles,
    );
    assert.equal(long.workers, 4);
    assert.equal(long.maxDepth, 10);
    assert.equal(
      planBudget(
        {
          workload: "test",
          durationMs: 100,
          memoryBytes: 300,
          maxWorkers: 4,
          maxDepth: 20,
          branching: 2,
        },
        profiles,
      ).workers,
      1,
    );
    assert.equal(
      planBudget(
        {
          workload: "test",
          durationMs: 100,
          memoryBytes: 100000,
          maxWorkers: 1,
          maxDepth: 3,
          branching: 2,
        },
        profiles,
      ).maxDepth,
      3,
    );
  });
  test("insufficient and uncalibrated budgets never become successful exploration", () => {
    assert.equal(
      planBudget(
        {
          workload: "unknown",
          durationMs: 100,
          memoryBytes: 100000,
          maxWorkers: 4,
          maxDepth: 10,
          branching: 2,
        },
        profiles,
      ).status,
      "uncalibrated",
    );
    assert.equal(
      planBudget(
        {
          workload: "test",
          durationMs: 0,
          memoryBytes: 100000,
          maxWorkers: 4,
          maxDepth: 10,
          branching: 2,
        },
        profiles,
      ).status,
      "insufficient-budget",
    );
    assert.throws(
      () =>
        planBudget(
          {
            workload: "test",
            durationMs: -1,
            memoryBytes: 100000,
            maxWorkers: 4,
            maxDepth: 10,
            branching: 2,
          },
          profiles,
        ),
      RangeError,
    );
  });
  test("packed and dynamic finite models generate the same results and action traces", () => {
    const table = compileCounterTable();
    assert.equal(table.offsets.length - 1, 56);
    assert.equal(table.actions.length, 432);
    for (const seed of [61, 62, 91, 100]) {
      for (const strategy of [0, 1]) {
        const options = {
          seed,
          operations: 512,
          depth: 16,
          strategy,
          repeats: 1,
          trace: true,
        };
        assert.deepEqual(runTable(table, options), runDynamic(table, options));
      }
    }
  });
  test("schedule depth bounds distinguish partial exploration from all interleavings", () => {
    assert.equal(enumerateSchedules(2, 4, 100).orders.length, 6);
    assert.equal(enumerateSchedules(3, 6, 10000).orders.length, 90);
    assert.equal(enumerateSchedules(2, 3, 100).bounded, true);
    assert.equal(enumerateSchedules(2, 3, 100).orders.length, 0);
    assert.equal(enumerateSchedules(2, 4, 2).bounded, true);
  });
};
