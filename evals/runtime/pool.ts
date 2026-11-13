import { Worker } from "node:worker_threads";
import { runScheduledCounter } from "../harness/scheduled-counter.js";
import { compileCounterTable, runTable } from "./table.js";
import type {
  CompletedWork,
  Reply,
  Work,
  WorkBatch,
  WorkResult,
} from "./work.js";

export interface RuntimePool {
  readonly workers: number;
  readonly startupMs: number;
  readonly run: (
    jobs: readonly Work[],
    deadline?: number,
  ) => Promise<WorkBatch>;
  readonly close: () => Promise<void>;
}

export const createPool = async (
  count: number,
  backend: "ts" | "wasm" = "ts",
  wasmPath?: string,
): Promise<RuntimePool> => {
  if (!Number.isSafeInteger(count) || count < 1)
    throw new RangeError("Invalid worker count");
  const start = performance.now();
  const workers = Array.from(
    { length: count },
    () =>
      new Worker(new URL("./worker.js", import.meta.url), {
        workerData: { backend, wasmPath },
      }),
  );
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => reject(error);
            worker.once("error", failed);
            worker.once("message", (ready: unknown) => {
              worker.off("error", failed);
              ready === "ready"
                ? resolve()
                : reject(new Error("Invalid worker handshake"));
            });
          }),
      ),
    );
  } catch (error) {
    await Promise.all(workers.map((worker) => worker.terminate()));
    throw error;
  }
  return {
    workers: count,
    startupMs: performance.now() - start,
    run: async (jobs, deadline = Infinity) => {
      const begin = performance.now();
      const completed: CompletedWork[] = [];
      const dispatched = new Set<number>();
      let next = 0;
      await Promise.all(
        workers.map(async (worker) => {
          while (next < jobs.length && performance.now() < deadline) {
            const index = next++;
            const job = jobs[index];
            if (!job) throw new Error("Missing worker job");
            dispatched.add(index);
            const started = performance.now();
            const result = await new Promise<WorkResult>((resolve, reject) => {
              const failed = (error: Error) => {
                worker.off("message", received);
                worker.off("exit", exited);
                reject(error);
              };
              const exited = () =>
                failed(new Error("Worker exited before completing a job"));
              const received = (reply: Reply) => {
                worker.off("error", failed);
                worker.off("exit", exited);
                if (reply.error || !reply.result)
                  reject(new Error(reply.error ?? "Missing worker result"));
                else resolve(reply.result);
              };
              worker.once("error", failed);
              worker.once("exit", exited);
              worker.once("message", received);
              worker.postMessage(job);
            });
            completed.push({
              index,
              result,
              elapsedMs: performance.now() - started,
            });
          }
        }),
      );
      return {
        completed: completed.sort((left, right) => left.index - right.index),
        remaining: jobs.flatMap((_, index) =>
          dispatched.has(index) ? [] : [index],
        ),
        elapsedMs: performance.now() - begin,
      };
    },
    close: async () => {
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
};

export const runInline = async (
  jobs: readonly Work[],
  deadline = Infinity,
): Promise<WorkBatch> => {
  const table = compileCounterTable();
  const start = performance.now();
  const completed: CompletedWork[] = [];
  for (
    let index = 0;
    index < jobs.length && performance.now() < deadline;
    index++
  ) {
    const job = jobs[index];
    if (!job) throw new Error("Missing inline job");
    const begin = performance.now();
    const result =
      job.kind === "kernel"
        ? runTable(table, job.options)
        : {
            broken: await runScheduledCounter(
              true,
              job.ordering,
              "concurrent",
              job.operations,
            ),
            fixed: await runScheduledCounter(
              false,
              job.ordering,
              "concurrent",
              job.operations,
            ),
          };
    completed.push({ index, result, elapsedMs: performance.now() - begin });
  }
  return {
    completed,
    remaining: jobs.flatMap((_, index) =>
      index < completed.length ? [] : [index],
    ),
    elapsedMs: performance.now() - start,
  };
};
