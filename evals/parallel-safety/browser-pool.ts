import { createClient } from "./client.js";
import type { WorkerSetup } from "./protocol.js";

export const createBrowserPool = async (
  url: URL,
  count: number,
  setup: WorkerSetup,
) => {
  if (!Number.isSafeInteger(count) || count < 1 || setup.backend !== "wasm")
    throw new RangeError("Invalid browser pool");
  const start = performance.now();
  const clients = Array.from({ length: count }, () => {
    const worker = new Worker(url, { type: "module" });
    const client = createClient({
      send: (message) => worker.postMessage(message),
      subscribe: (message, error) => {
        worker.addEventListener("message", (event) => message(event.data));
        worker.addEventListener("error", (event) =>
          error(new Error(event.message)),
        );
        worker.addEventListener("messageerror", () =>
          error(new Error("Worker message could not be decoded")),
        );
      },
      close: async () => worker.terminate(),
    });
    worker.postMessage(setup);
    return client;
  });
  try {
    await Promise.all(clients.map((client) => client.ready));
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
  return {
    startupMs: performance.now() - start,
    executors: clients.map((client) => client.executor),
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    },
  };
};
