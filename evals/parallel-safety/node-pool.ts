import { Worker } from "node:worker_threads";
import { createClient } from "./client.js";
import type { WorkerSetup } from "./protocol.js";

export const createNodePool = async (workers: number, setup: WorkerSetup) => {
  if (!Number.isSafeInteger(workers) || workers < 1)
    throw new RangeError("Invalid worker count");
  const started = performance.now();
  const clients = Array.from({ length: workers }, () => {
    const worker = new Worker(new URL("./node-worker.js", import.meta.url), {
      workerData: setup,
    });
    let closing = false;
    const completion = new Promise<void>((resolve) =>
      worker.once("exit", () => resolve()),
    );
    return createClient({
      send: (message) => worker.postMessage(message),
      subscribe: (message, error) => {
        worker.on("message", message);
        worker.on("error", error);
        worker.on("exit", (code) => {
          if (!closing) error(new Error(`Worker exited: ${code}`));
        });
      },
      close: async () => {
        closing = true;
        worker.postMessage({ type: "close" });
        await completion;
      },
    });
  });
  try {
    await Promise.all(clients.map((client) => client.ready));
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
  return {
    startupMs: performance.now() - started,
    executors: clients.map((client) => client.executor),
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
};
