import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, cpus, release } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
  ScheduledCompletion,
  ScheduledRun,
  SchedulingProfile,
} from "../../src/contracts.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety, decodeSafetyResult } from "../../src/safety.js";
import { planSchedule, runSchedule } from "../../src/scheduling.js";
import { verifyManifest } from "../../src/sharding.js";
import { isRecord } from "../../src/trace.js";
import { nativePath, wasmPath } from "../checker-benchmark/engines.js";
import { order, summarize } from "../checker-benchmark/protocol.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { corpus } from "./corpus.js";
import { createNodePool } from "./node-pool.js";
import { createProcessor } from "./processor.js";
import type { SafetyJob, SafetyOutcome } from "./protocol.js";
import { fingerprint } from "./provenance.js";

export interface Sample {
  readonly backend: "wasm" | "native";
  readonly workers: number;
  readonly workload: string;
  readonly policy: "fifo" | "cost";
  readonly iteration: number;
  readonly warmup: boolean;
  readonly elapsedMs: number;
  readonly tasksPerSecond: number;
  readonly p95QueuedMs: number;
  readonly batches: number;
  readonly outcomeSha256: string;
  readonly memory: ReturnType<typeof memory>;
  readonly dispatches: ScheduledRun<SafetyOutcome>["dispatches"];
}
const memory = () => {
  const children = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,comm="])
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match &&
        Number(match[2]) === process.pid &&
        match[4]?.endsWith("modelt-core")
        ? [{ pid: Number(match[1]), rss: Number(match[3]) * 1024 }]
        : [];
    });
  return {
    nodeRss: process.memoryUsage().rss,
    nativeRss: children.reduce((sum, child) => sum + child.rss, 0),
    children,
  };
};
const directory = process.argv[2];
assert.ok(directory, "Pass a new output directory");
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const files: string[] = [];
const write = async (path: string, value: unknown) => {
  await writeFile(
    join(directory, path),
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx" },
  );
  files.push(path);
};
const source = await fingerprint();
const samples: Sample[] = [];
try {
  const bytes = await readFile(wasmPath);
  const data = await corpus(source.sourceVersion);
  await verifyManifest(data.manifest);
  await write("manifest.json", {
    plan: "0017-parallel-safety",
    ...source,
    commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    dirtyPaths: execFileSync("git", ["status", "--short"]).toString().trim(),
    startedAt: new Date().toISOString(),
    node: process.version,
    arch: process.arch,
    os: release(),
    cpu: cpus()[0]?.model,
    availableParallelism: availableParallelism(),
    wasmSha256: digest(bytes),
    nativeSha256: digest(await readFile(nativePath)),
    warmup: 2,
    measurements: 7,
    batchTargetMs: 4,
    maxBatchSize: 16,
    memoryPolicy:
      "Estimates, not enforced limits. RSS snapshots after batches, not strict peak RSS.",
    poolOrder:
      "1/2/4/8; backend order reverses at each size; rotate workload/policy within each reused pool",
  });
  await write("inputs.json", data);
  const expected: Record<
    string,
    readonly ScheduledCompletion<SafetyOutcome>[]
  > = {};
  const costs: Record<string, Record<string, number>> = {};
  const calibration: unknown[] = [];
  for (const backend of ["wasm", "native"] as const) {
    const core =
      backend === "wasm" ? await createPortableWasm(bytes) : undefined;
    const native = backend === "native" ? startNative() : undefined;
    const processor = createProcessor(
      data.programs,
      data.jobs,
      async (program, bounds) => {
        if (core) return checkSafety(core, program, bounds);
        const result = await native?.request({
          version: 1,
          request: { kind: "check-safety", program, bounds },
        });
        assert.ok(isRecord(result) && result.kind === "safety");
        return decodeSafetyResult(result.result);
      },
    );
    costs[backend] = {};
    try {
      for (const entry of data.programs) {
        const job = data.jobs.find((job) => job.program === entry.id);
        assert.ok(job);
        const timings = [];
        for (let iteration = 0; iteration < 7; iteration++) {
          const start = performance.now();
          const result = await processor([job.id]);
          const elapsedMs = performance.now() - start;
          timings.push(elapsedMs);
          calibration.push({
            backend,
            program: entry.id,
            iteration,
            warmup: iteration < 2,
            elapsedMs,
            result,
          });
        }
        costs[backend][entry.id] = summarize(timings.slice(2)).median;
      }
      expected[backend] = await processor(data.jobs.map((job) => job.id));
      for (const completion of expected[backend]) {
        const input = data.manifest.tasks.find(
          (task) => task.id === completion.id,
        );
        assert.ok(input && completion.result.status === "ok");
        assert.equal(completion.result.result.status, "complete");
        assert.equal(completion.result.result.states, input.payload.states);
        assert.equal(
          completion.result.result.generated,
          input.payload.generated,
        );
        assert.equal(completion.result.result.violation, null);
      }
    } finally {
      await native?.close();
    }
  }
  assert.deepEqual(expected.wasm, expected.native);
  await write("calibration.json", { models: calibration, costs });
  await write("expected.json", expected);
  await writeFile(join(directory, "samples.jsonl"), "", { flag: "wx" });
  files.push("samples.jsonl");
  const poolProfiles: unknown[] = [];
  for (const [position, workers] of [1, 2, 4, 8].entries()) {
    for (const backend of order(["wasm", "native"] as const, position)) {
      const jobs: SafetyJob[] = data.jobs.map((job) => ({
        ...job,
        estimatedMs: costs[backend]?.[job.program] ?? 0,
      }));
      const pool = await createNodePool(workers, {
        backend,
        bytes,
        programs: data.programs,
        jobs,
      });
      const reference = expected[backend];
      assert.ok(reference);
      const conditions = ["mixed", "tiny"].flatMap((workload) =>
        (["fifo", "cost"] as const).map((policy) => ({ workload, policy })),
      );
      try {
        const profiles: SchedulingProfile[] = [
          {
            id: `${backend}-${workers}`,
            workers,
            startupMs: 0,
            costScale: 1,
            fixedMemoryBytes: workers * 128 * 1024 * 1024,
          },
        ];
        for (let iteration = 0; iteration < 9; iteration++) {
          for (const condition of order(conditions, iteration)) {
            const selected = jobs.filter(
              (job) =>
                data.manifest.tasks.find((task) => task.id === job.id)?.payload
                  .workload === condition.workload,
            );
            const plan = planSchedule(
              selected,
              profiles,
              {
                durationMs: 120000,
                memoryBytes: 8 * 1024 ** 3,
                maxWorkers: workers,
              },
              { policy: condition.policy, batchTargetMs: 4, maxBatchSize: 16 },
            );
            assert.equal(plan.status, "planned");
            const actual = await runSchedule(plan, pool.executors);
            const wanted = reference.filter((entry) =>
              selected.some((job) => job.id === entry.id),
            );
            if (
              actual.executionStatus !== "complete" ||
              JSON.stringify(actual.completed) !== JSON.stringify(wanted)
            ) {
              await write(
                `mismatch-${backend}-${workers}-${condition.workload}-${condition.policy}-${iteration}.json`,
                { actual, wanted, plan },
              );
              throw new Error(
                "Parallel results differed from sequential reference",
              );
            }
            const waits = actual.dispatches
              .flatMap((dispatch) => dispatch.ids.map(() => dispatch.queuedMs))
              .sort((left, right) => left - right);
            const sample: Sample = {
              backend,
              workers,
              ...condition,
              iteration,
              warmup: iteration < 2,
              elapsedMs: actual.elapsedMs,
              tasksPerSecond: (selected.length * 1000) / actual.elapsedMs,
              p95QueuedMs: waits[Math.ceil(waits.length * 0.95) - 1] ?? 0,
              batches: actual.dispatches.length,
              outcomeSha256: digest(JSON.stringify(actual.completed)),
              memory: memory(),
              dispatches: actual.dispatches,
            };
            samples.push(sample);
            await appendFile(
              join(directory, "samples.jsonl"),
              `${JSON.stringify(sample)}\n`,
            );
            if (iteration === 1)
              poolProfiles.push({
                backend,
                workers,
                ...condition,
                startupMs: pool.startupMs,
                costScale:
                  actual.elapsedMs / Math.max(plan.estimatedMs, Number.EPSILON),
                fixedMemoryBytes: profiles[0]?.fixedMemoryBytes,
                calibrationOnly: true,
              });
          }
        }
        console.log(
          JSON.stringify({
            backend,
            workers,
            startupMs: pool.startupMs,
            medians: conditions.map((condition) => ({
              ...condition,
              ...summarize(
                samples
                  .filter(
                    (sample) =>
                      sample.backend === backend &&
                      sample.workers === workers &&
                      sample.workload === condition.workload &&
                      sample.policy === condition.policy &&
                      !sample.warmup,
                  )
                  .map((sample) => sample.elapsedMs),
              ),
            })),
          }),
        );
      } finally {
        await pool.close();
      }
    }
  }
  await write("profiles.json", poolProfiles);
  const adaptive = [];
  for (const backend of ["wasm", "native"] as const) {
    const jobs = data.jobs
      .filter(
        (job) =>
          data.manifest.tasks.find((task) => task.id === job.id)?.payload
            .workload === "mixed",
      )
      .map((job) => ({
        ...job,
        estimatedMs: costs[backend]?.[job.program] ?? 0,
      }));
    const profiles: SchedulingProfile[] = poolProfiles.flatMap((value) => {
      assert.ok(isRecord(value));
      return value.backend === backend &&
        value.workload === "mixed" &&
        value.policy === "cost"
        ? [
            {
              id: `${backend}-${value.workers}`,
              workers: Number(value.workers),
              startupMs: Number(value.startupMs),
              costScale: Number(value.costScale),
              fixedMemoryBytes: Number(value.fixedMemoryBytes),
            },
          ]
        : [];
    });
    for (const memoryBytes of [512 * 1024 ** 2, 8 * 1024 ** 3]) {
      const plan = planSchedule(
        jobs,
        profiles,
        { durationMs: 30000, memoryBytes, maxWorkers: 8 },
        { policy: "cost", batchTargetMs: 4, maxBatchSize: 16 },
      );
      assert.equal(plan.status, "planned");
      const pool = await createNodePool(plan.workers, {
        backend,
        bytes,
        programs: data.programs,
        jobs,
      });
      try {
        const actual = await runSchedule(plan, pool.executors);
        assert.equal(actual.executionStatus, "complete");
        assert.deepEqual(
          actual.completed,
          expected[backend]?.filter((entry) =>
            jobs.some((job) => job.id === entry.id),
          ),
        );
        adaptive.push({ backend, memoryBytes, plan, actual, memory: memory() });
      } finally {
        await pool.close();
      }
    }
    const rejected = planSchedule(
      jobs,
      profiles,
      { durationMs: 0, memoryBytes: 8 * 1024 ** 3, maxWorkers: 8 },
      { policy: "cost", batchTargetMs: 4, maxBatchSize: 16 },
    );
    assert.equal(rejected.status, "insufficient-budget");
    const actual = await runSchedule<SafetyOutcome>(rejected, []);
    assert.equal(actual.executionStatus, "partial");
    adaptive.push({ backend, plan: rejected, actual });
  }
  await write("adaptive.json", adaptive);
  assert.equal(
    (await fingerprint()).sourceVersion,
    source.sourceVersion,
    "Sources changed during measurement",
  );
  await write("result.json", {
    status: "complete",
    sourceVersion: source.sourceVersion,
    tasks: data.jobs.length,
    samples: samples.length,
    measurements: samples.filter((sample) => !sample.warmup).length,
    files: await Promise.all(
      files.map(async (path) => ({
        path,
        sha256: digest(await readFile(join(directory, path))),
      })),
    ),
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "parallel-safety", status: "complete", sourceVersion: source.sourceVersion })}\n`,
  );
} catch (error) {
  await write("error.json", {
    status: "error",
    message: String(error),
    samples: samples.length,
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "parallel-safety", status: "error", sourceVersion: source.sourceVersion })}\n`,
  );
  throw error;
}
