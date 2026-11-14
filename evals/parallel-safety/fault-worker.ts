import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("Expected worker port");
const port = parentPort;
port.on("message", (message) => {
  if (workerData === "exit") process.exit(1);
  const output = {
    id: message.ids[0],
    result: {
      status: "error",
      code: "protocol",
      message: "intentional transport control",
    },
  };
  port.postMessage({
    type: "result",
    id: message.id,
    completed: workerData === "drop" ? [] : [output, output],
  });
});
port.postMessage({ type: "ready" });
