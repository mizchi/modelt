import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join, resolve } from "node:path";
import { counterModel } from "../../examples/counter-model.js";
import { createCounter } from "../../examples/durable-counter.js";
import { planBudget, type RuntimeProfile } from "../../src/budget.js";
import { checkConformance } from "../../src/index.js";
import { runNative } from "./native.js";
import { createPool, runInline } from "./pool.js";
import { runtimeFingerprint } from "./provenance.js";
import { executeScheduledBudget } from "./scheduler.js";
import { enumerateSchedules } from "./schedules.js";
import {
  compileCounterTable,
  decodeCases,
  runDynamic,
  runTable,
} from "./table.js";
import { createWasmKernel, encodeTable } from "./wasm.js";
import type { Work, WorkBatch } from "./work.js";

interface Timing {
  readonly round: number;
  readonly engine: string;
  readonly operations: number;
  readonly repeats: number;
  readonly totalMs: number;
  readonly kernelMs: number;
  readonly checksum: number;
}
interface EndToEnd {
  readonly round: number;
  readonly engine: string;
  readonly generationMs: number;
  readonly driverAndOracleMs: number;
  readonly totalMs: number;
}
interface Calibration extends RuntimeProfile {
  readonly samples: readonly number[];
  readonly visits: number;
  readonly memoryEstimate: string;
}

const output = process.argv[2] ?? ".artifacts/runtime-evaluation";
await mkdir(output, { recursive: false });
const writeJson = async (name: string, value: unknown) =>
  writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const fingerprint = await runtimeFingerprint();
const wasmPath = resolve(
  "evals/rust-probe/target/wasm32-unknown-unknown/release/modelt_runtime_probe.wasm",
);
const binary = resolve("evals/rust-probe/target/release/modelt-runtime-probe");
const manifest = {
  version: 1,
  startedAt: new Date().toISOString(),
  ...fingerprint,
  plan: "evals/plans/0003-runtime.md",
  node: process.version,
  rust: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim(),
  platform: process.platform,
  arch: process.arch,
  availableParallelism: availableParallelism(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  dirtyPaths: execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean),
};
await writeJson("manifest.json", manifest);
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};
try {
  const compileStart = performance.now();
  const table = compileCounterTable();
  const compileMs = performance.now() - compileStart;
  const wasmStart = performance.now();
  const wasm = await createWasmKernel(await readFile(wasmPath), table);
  const wasmSetupMs = performance.now() - wasmStart;
  const tablePath = join(output, "table.bin");
  await writeFile(tablePath, encodeTable(table), { flag: "wx" });
  for (let seed = 61; seed <= 100; seed++) {
    const options = {
      seed,
      operations: 512,
      depth: 16,
      strategy: seed % 2,
      repeats: 1,
      trace: true,
    };
    assert.deepEqual(wasm.run(options), runDynamic(table, options));
    assert.deepEqual(runTable(table, options), runDynamic(table, options));
  }
  const engines = [
    "dynamic-ts",
    "packed-ts",
    "rust-wasm",
    "rust-native",
  ] as const;
  const timings: Timing[] = [];
  for (const operations of [512, 65536]) {
    const options = {
      seed: 61,
      operations,
      depth: 16,
      strategy: 1,
      repeats: 8,
      trace: false,
    };
    const expected = runTable(table, options);
    const run = async (engine: (typeof engines)[number]) => {
      const start = performance.now();
      const native =
        engine === "rust-native"
          ? await runNative(binary, tablePath, options)
          : null;
      const result =
        native?.result ??
        (engine === "dynamic-ts"
          ? runDynamic(table, options)
          : engine === "packed-ts"
            ? runTable(table, options)
            : wasm.run(options));
      const totalMs = performance.now() - start;
      assert.deepEqual(result, expected);
      return {
        engine,
        operations,
        repeats: 8,
        totalMs,
        kernelMs: native?.kernelMs ?? totalMs,
        checksum: result.checksum,
      };
    };
    for (let round = 0; round < 3; round++)
      for (const engine of engines) await run(engine);
    for (let round = 0; round < 7; round++)
      for (const engine of round % 2 === 0 ? engines : engines.toReversed())
        timings.push({ round, ...(await run(engine)) });
  }
  const endToEnd: EndToEnd[] = [];
  for (let round = 0; round < 7; round++) {
    for (const engine of round % 2 === 0
      ? ["dynamic-ts", "packed-ts", "rust-wasm"]
      : ["rust-wasm", "packed-ts", "dynamic-ts"]) {
      const start = performance.now();
      const options = {
        seed: 61 + round,
        operations: 512,
        depth: 16,
        strategy: 1,
        repeats: 1,
        trace: true,
      };
      const generated =
        engine === "dynamic-ts"
          ? runDynamic(table, options)
          : engine === "packed-ts"
            ? runTable(table, options)
            : wasm.run(options);
      const generationMs = performance.now() - start;
      const cases = decodeCases(table, generated.trace);
      const sutStart = performance.now();
      for (const actions of cases)
        assert.equal(
          (await checkConformance(counterModel, createCounter(), actions))
            .status,
          "matched",
        );
      endToEnd.push({
        round,
        engine,
        generationMs,
        driverAndOracleMs: performance.now() - sutStart,
        totalMs: performance.now() - start,
      });
    }
  }
  const kernelJobs: Work[] = Array.from({ length: 16 }, (_, index) => ({
    kind: "kernel",
    options: {
      seed: 61 + index,
      operations: 65536,
      depth: 16,
      strategy: 1,
      repeats: 1,
      trace: false,
    },
  }));
  const profiles: RuntimeProfile[] = [];
  const calibration: Calibration[] = [];
  const calibrate = async (
    id: string,
    workers: number,
    startupMs: number,
    execute: (jobs: readonly Work[]) => Promise<WorkBatch>,
    workload: string,
    jobs: readonly Work[],
    bytesPerState: number,
  ) => {
    for (let round = 0; round < 3; round++) await execute(jobs);
    const samples = [];
    let visits = jobs.length;
    for (let round = 0; round < 7; round++) {
      const batch = await execute(jobs);
      assert.equal(batch.completed.length, jobs.length);
      if (workload === "counter-transitions")
        visits = batch.completed.reduce(
          (total, item) =>
            total + ("steps" in item.result ? item.result.steps : 0),
          0,
        );
      samples.push(batch.elapsedMs);
    }
    const profile = {
      id,
      workload,
      workers,
      startupMs,
      visitsPerMs: visits / median(samples),
      fixedMemoryBytes: process.memoryUsage().rss,
      bytesPerState,
    };
    profiles.push(profile);
    calibration.push({
      ...profile,
      samples,
      visits,
      memoryEstimate: "RSS snapshot; prefix memory estimate is advisory",
    });
  };
  await calibrate(
    "inline-kernel",
    1,
    0,
    runInline,
    "counter-transitions",
    kernelJobs,
    0,
  );
  for (const operations of [2, 3]) {
    const jobs: Work[] = enumerateSchedules(
      operations,
      operations * 2,
      10000,
    ).orders.map((ordering) => ({ kind: "schedule", operations, ordering }));
    await calibrate(
      `inline-async-${operations}`,
      1,
      0,
      runInline,
      `async-counter-${operations}`,
      jobs,
      64,
    );
  }
  for (const workers of [
    ...new Set([
      1,
      Math.min(2, availableParallelism()),
      Math.min(4, availableParallelism()),
    ]),
  ]) {
    const pool = await createPool(workers);
    try {
      await calibrate(
        `pool-${workers}-kernel`,
        workers,
        pool.startupMs,
        pool.run,
        "counter-transitions",
        kernelJobs,
        0,
      );
      const fresh = profiles.at(-1);
      if (!fresh) throw new Error("Missing measured profile");
      profiles.push({ ...fresh, id: `${fresh.id}-reused`, startupMs: 0 });
      for (const operations of [2, 3]) {
        const jobs: Work[] = enumerateSchedules(
          operations,
          operations * 2,
          10000,
        ).orders.map((ordering) => ({
          kind: "schedule",
          operations,
          ordering,
        }));
        await calibrate(
          `pool-${workers}-async-${operations}`,
          workers,
          pool.startupMs,
          pool.run,
          `async-counter-${operations}`,
          jobs,
          64,
        );
      }
    } finally {
      await pool.close();
    }
  }
  const allocations = [10, 100, 1000].map((durationMs) =>
    planBudget(
      {
        workload: "counter-transitions",
        durationMs,
        memoryBytes: 1024 ** 3,
        maxWorkers: Math.min(4, availableParallelism()),
        maxDepth: 32,
        branching: 2,
      },
      profiles,
    ),
  );
  const schedules = [];
  for (const operations of [2, 3])
    for (const durationMs of [0, 1, 10, 100]) {
      const execution = await executeScheduledBudget(
        operations,
        {
          workload: `async-counter-${operations}`,
          durationMs,
          memoryBytes: 1024 ** 3,
          maxWorkers: Math.min(4, availableParallelism()),
          maxDepth: operations * 2,
          branching: operations,
        },
        profiles,
      );
      schedules.push({ operations, durationMs, ...execution });
    }
  if ((await runtimeFingerprint()).sourceVersion !== fingerprint.sourceVersion)
    throw new Error("Source changed during the runtime evaluation");
  const summary = {
    status: "complete",
    finishedAt: new Date().toISOString(),
    semanticChecks: { seeds: "61..100", mismatch: 0 },
    setup: { compileMs, wasmSetupMs, wasmBytes: (await stat(wasmPath)).size },
    engines: [512, 65536].flatMap((operations) =>
      engines.map((engine) => {
        const rows = timings.filter(
          (row) => row.operations === operations && row.engine === engine,
        );
        return {
          engine,
          operations,
          repeats: 8,
          medianTotalMs: median(rows.map((row) => row.totalMs)),
          medianKernelMs: median(rows.map((row) => row.kernelMs)),
        };
      }),
    ),
    endToEnd: ["dynamic-ts", "packed-ts", "rust-wasm"].map((engine) => {
      const rows = endToEnd.filter((row) => row.engine === engine);
      return {
        engine,
        medianTotalMs: median(rows.map((row) => row.totalMs)),
        medianGenerationMs: median(rows.map((row) => row.generationMs)),
        medianDriverAndOracleMs: median(
          rows.map((row) => row.driverAndOracleMs),
        ),
      };
    }),
    allocations,
    schedules: schedules.map((row) => ({
      operations: row.operations,
      durationMs: row.durationMs,
      status: row.status,
      workers: row.plan.workers,
      depth: row.plan.maxDepth,
      checked: row.checked,
      coverageComplete: row.coverageComplete,
      violations: row.counterexamples.length,
      elapsedMs: row.elapsedMs,
    })),
  };
  await writeJson("timings.json", { timings, endToEnd, calibration });
  await writeJson("profiles.json", profiles);
  await writeJson("schedules.json", schedules);
  await writeJson("result.json", summary);
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  await writeJson("error.json", {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
