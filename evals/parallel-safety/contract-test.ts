import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { PortableCoreError } from "../../src/portable-value.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { planSchedule, runSchedule } from "../../src/scheduling.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { cases } from "../rust-safety/cases.js";
import { createClient } from "./client.js";
import { createNodePool } from "./node-pool.js";
import type { SafetyJob } from "./protocol.js";

const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const core = await createPortableWasm(bytes);
const complex = await import("../collections-temporal/cases.js");
const inputs = [
  ...cases.filter((input) =>
    [
      "cycle",
      "violation",
      "depth-cut",
      "empty",
      "assumption",
      "false-constant-invariant",
      "type-error",
    ].includes(input.name),
  ),
  ...complex.cases.filter((input) =>
    ["action-property", "eventually-stuttering", "temporal-node-cut"].includes(
      input.name,
    ),
  ),
];
const programs = inputs.map((input) => ({
  id: input.name,
  program: compileTlaSafety(input),
}));
const jobs: SafetyJob[] = inputs.map((input) => ({
  id: input.name,
  program: input.name,
  bounds: input.bounds ?? { maxDepth: 10, maxStates: 100, maxWork: 10000 },
  estimatedMs: 1,
  memoryBytes: 1024,
}));
const profiles = [
  {
    id: "test",
    workers: 2,
    startupMs: 0,
    costScale: 1,
    fixedMemoryBytes: 1024,
  },
];
const plan = planSchedule(
  jobs,
  profiles,
  { maxWorkers: 2, durationMs: 10000, memoryBytes: 1048576 },
  { policy: "cost", batchTargetMs: 4, maxBatchSize: 2 },
);

for (const backend of ["native", "wasm"] as const)
  test(`real ${backend} workers retain partial and violation results across reused batches`, async () => {
    assert.ok(jobs.length >= 3, "Missing correctness fixtures");
    const pool = await createNodePool(2, { backend, bytes, programs, jobs });
    try {
      for (let repeat = 0; repeat < 2; repeat++) {
        const actual = await runSchedule(plan, pool.executors);
        assert.equal(actual.executionStatus, "complete");
        assert.deepEqual(actual.remaining, []);
        assert.deepEqual(
          [
            ...new Set(
              actual.completed.map((entry) =>
                entry.result.status === "ok"
                  ? entry.result.result.status
                  : "error",
              ),
            ),
          ].sort(),
          [
            "assumption-violation",
            "bounded",
            "complete",
            "empty",
            "error",
            "invariant-violation",
            "liveness-violation",
            "property-violation",
          ],
        );
        for (const entry of programs) {
          const job = jobs.find((job) => job.program === entry.id);
          assert.ok(job);
          try {
            assert.deepEqual(
              actual.completed.find((result) => result.id === job.id)?.result,
              {
                status: "ok",
                result: checkSafety(core, entry.program, job.bounds),
              },
            );
          } catch (error) {
            if (!(error instanceof PortableCoreError)) throw error;
            assert.deepEqual(
              actual.completed.find((result) => result.id === job.id)?.result,
              { status: "error", code: error.code, message: error.message },
            );
          }
        }
      }
      const stopped = await runSchedule(plan, pool.executors, 0);
      assert.equal(stopped.executionStatus, "partial");
      assert.deepEqual(
        stopped.remaining,
        jobs.map((job) => job.id),
      );
      assert.deepEqual(stopped.dispatches, []);
    } finally {
      await pool.close();
    }
  });

test("worker failure and missing responses leave tasks unresolved", async () => {
  for (const fault of ["exit", "drop", "duplicate"] as const) {
    const worker = new Worker(new URL("./fault-worker.js", import.meta.url), {
      workerData: fault,
    });
    const client = createClient({
      send: (message) => worker.postMessage(message),
      subscribe: (message, error) => {
        worker.on("message", message);
        worker.on("error", error);
        worker.on("exit", () => error(new Error("Worker exited")));
      },
      close: async () => {
        await worker.terminate();
      },
    });
    try {
      await client.ready;
      const single = planSchedule(
        jobs,
        [
          {
            id: "fault-control",
            workers: 1,
            startupMs: 0,
            costScale: 1,
            fixedMemoryBytes: 1024,
          },
        ],
        { maxWorkers: 1, durationMs: 10000, memoryBytes: 1048576 },
        { policy: "cost", batchTargetMs: 100, maxBatchSize: 100 },
      );
      const result = await runSchedule(single, [client.executor]);
      assert.equal(result.executionStatus, "partial");
      assert.equal(result.completed.length, 0);
      assert.deepEqual(
        result.remaining,
        jobs.map((job) => job.id),
      );
      assert.ok(result.dispatches[0]?.error);
    } finally {
      await client.close();
    }
  }
});
