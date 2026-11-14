import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { isRecord } from "../../src/trace.js";
import { createProcessor } from "./processor.js";
import type { WorkerSetup } from "./protocol.js";

let processBatch: ReturnType<typeof createProcessor> | undefined;
addEventListener("message", async (event: MessageEvent<unknown>) => {
  const message = event.data;
  if (!processBatch) {
    const setup: WorkerSetup = event.data as WorkerSetup;
    if (setup.backend !== "wasm")
      throw new Error("Browser worker requires Wasm");
    const core = await createPortableWasm(setup.bytes);
    processBatch = createProcessor(
      setup.programs,
      setup.jobs,
      async (program, bounds) => checkSafety(core, program, bounds),
    );
    postMessage({ type: "ready" });
    return;
  }
  if (
    !isRecord(message) ||
    message.type !== "run" ||
    !Array.isArray(message.ids) ||
    message.ids.some((id: unknown) => typeof id !== "string")
  )
    throw new Error("Invalid batch request");
  postMessage({
    type: "result",
    id: message.id,
    completed: await processBatch(message.ids),
  });
});
