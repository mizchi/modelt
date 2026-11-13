import { compileCounterTable, runTable } from "../evals/runtime/table.js";
import { createWasmKernel } from "../evals/runtime/wasm.js";
import { planBudget } from "../src/budget.js";
import {
  createManifest,
  mergeReports,
  partitionTasks,
} from "../src/sharding.js";

export const run = async (): Promise<Record<string, unknown>> => {
  const table = compileCounterTable();
  const wasm = await createWasmKernel(
    new Uint8Array(await (await fetch("/runtime.wasm")).arrayBuffer()),
    table,
  );
  const options = {
    seed: 61,
    operations: 512,
    depth: 16,
    strategy: 1,
    repeats: 1,
    trace: true,
  };
  const actual = wasm.run(options);
  const reference = runTable(table, options);
  if (JSON.stringify(actual) !== JSON.stringify(reference))
    throw new Error("Rust browser semantics differ");
  const manifest = await createManifest(
    { workload: "browser", sourceVersion: "test" },
    [{ key: "seed-61", payload: options }],
  );
  const partition = [0, 1].flatMap((index) =>
    partitionTasks(manifest, index, 2),
  );
  const merged = await mergeReports(
    manifest,
    partition.map((task) => ({
      manifestId: manifest.id,
      sourceVersion: manifest.sourceVersion,
      taskId: task.id,
      status: "ok" as const,
      result: actual,
    })),
  );
  const budget = planBudget(
    {
      workload: "browser",
      durationMs: 10,
      memoryBytes: 100000,
      maxWorkers: 1,
      maxDepth: 10,
      branching: 2,
    },
    [
      {
        id: "browser-ts",
        workload: "browser",
        workers: 1,
        startupMs: 0,
        visitsPerMs: 100,
        fixedMemoryBytes: 100,
        bytesPerState: 4,
      },
    ],
  );
  return {
    matched: true,
    steps: actual.steps,
    states: table.offsets.length - 1,
    sharding: merged.status,
    workers: budget.workers,
    depth: budget.maxDepth,
  };
};
