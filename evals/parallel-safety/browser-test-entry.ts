import { planSchedule, runSchedule } from "../../src/scheduling.js";
import { createBrowserPool } from "./browser-pool.js";
import type { WorkerSetup } from "./protocol.js";

export const run = async () => {
  const input: Omit<WorkerSetup, "bytes"> = await (
    await fetch("/setup.json")
  ).json();
  const bytes = new Uint8Array(await (await fetch("/core.wasm")).arrayBuffer());
  const plan = planSchedule(
    input.jobs,
    [
      {
        id: "browser",
        workers: 2,
        startupMs: 0,
        costScale: 1,
        fixedMemoryBytes: 0,
      },
    ],
    { durationMs: 10000, memoryBytes: 104857600, maxWorkers: 2 },
    { policy: "cost", batchTargetMs: 4, maxBatchSize: 2 },
  );
  const pool = await createBrowserPool(
    new URL("/worker.js", location.href),
    2,
    { ...input, bytes },
  );
  try {
    const first = await runSchedule(plan, pool.executors);
    const second = await runSchedule(plan, pool.executors);
    const exhausted = await runSchedule(plan, pool.executors, 0);
    return {
      isolated: globalThis.crossOriginIsolated,
      first,
      second,
      exhausted,
    };
  } finally {
    await pool.close();
  }
};
