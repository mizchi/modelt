import { parentPort, workerData } from "node:worker_threads";
import { PortableCoreError } from "../../src/portable-value.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety, decodeSafetyResult } from "../../src/safety.js";
import { isRecord } from "../../src/trace.js";
import { startNative } from "../usable/native.js";
import { createProcessor } from "./processor.js";
import type { WorkerSetup } from "./protocol.js";

if (!parentPort) throw new Error("Expected worker port");
const port = parentPort;
const setup: WorkerSetup = workerData;
const core =
  setup.backend === "wasm" ? await createPortableWasm(setup.bytes) : undefined;
const native = setup.backend === "native" ? startNative() : undefined;
if (native)
  await native.request({
    version: 1,
    request: { kind: "shrink-candidates", length: 0 },
  });
const processBatch = createProcessor(
  setup.programs,
  setup.jobs,
  async (program, bounds) => {
    if (core) return checkSafety(core, program, bounds);
    const result = await native?.request({
      version: 1,
      request: { kind: "check-safety", program, bounds },
    });
    if (!isRecord(result)) throw new Error("Missing native result");
    if (
      result.kind === "error" &&
      (result.code === "protocol" || result.code === "value") &&
      typeof result.message === "string"
    )
      throw new PortableCoreError(result.code, result.message);
    if (result.kind !== "safety") throw new Error("Invalid native response");
    return decodeSafetyResult(result.result);
  },
);
port.on("message", async (message: unknown) => {
  if (isRecord(message) && message.type === "close") {
    await native?.close();
    port.close();
    return;
  }
  if (
    !isRecord(message) ||
    message.type !== "run" ||
    !Array.isArray(message.ids) ||
    message.ids.some((id: unknown) => typeof id !== "string")
  )
    throw new Error("Invalid batch request");
  const completed = await processBatch(message.ids);
  port.postMessage({ type: "result", id: message.id, completed });
});
port.postMessage({ type: "ready" });
