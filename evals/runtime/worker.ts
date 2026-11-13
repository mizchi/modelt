import { readFile } from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { isRecord } from "../../src/trace.js";
import { runScheduledCounter } from "../harness/scheduled-counter.js";
import { compileCounterTable, runTable } from "./table.js";
import { createWasmKernel } from "./wasm.js";
import type { Reply, Work } from "./work.js";

if (!parentPort) throw new Error("Worker requires a parent port");
const port = parentPort;
const setup: unknown = workerData;
if (!isRecord(setup) || (setup.backend !== "ts" && setup.backend !== "wasm"))
  throw new Error("Invalid worker backend");
const table = compileCounterTable();
const wasm =
  setup.backend === "wasm" && typeof setup.wasmPath === "string"
    ? await createWasmKernel(await readFile(setup.wasmPath), table)
    : null;
if (setup.backend === "wasm" && !wasm) throw new Error("Missing Wasm runtime");
port.postMessage("ready");
port.on("message", async (work: Work) => {
  try {
    const result =
      work.kind === "kernel"
        ? wasm
          ? wasm.run(work.options)
          : runTable(table, work.options)
        : {
            broken: await runScheduledCounter(
              true,
              work.ordering,
              "concurrent",
              work.operations,
            ),
            fixed: await runScheduledCounter(
              false,
              work.ordering,
              "concurrent",
              work.operations,
            ),
          };
    const reply: Reply = { result };
    port.postMessage(reply);
  } catch (error) {
    const reply: Reply = {
      error: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(reply);
  }
});
