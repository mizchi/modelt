import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { PortableCommand } from "../../src/contracts.js";

export const startNative = () => {
  const child = spawn("crates/modelt-core/target/release/modelt-core", [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  let stderr = "";
  let stopped = false;
  const completion = new Promise<number | null>((resolve) =>
    child.once("close", (code) => {
      stopped = true;
      for (const request of pending.splice(0))
        request.reject(new Error(`Native process closed: ${code} ${stderr}`));
      resolve(code);
    }),
  );
  child.on("error", (error) => {
    stopped = true;
    for (const request of pending.splice(0)) request.reject(error);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const request = pending.shift();
    if (!request) return;
    try {
      request.resolve(JSON.parse(line));
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  return {
    request: (command: PortableCommand): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (stopped) {
          reject(new Error("Native process stopped"));
          return;
        }
        pending.push({ resolve, reject });
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }),
    close: async () => {
      child.stdin.end();
      const code = await completion;
      lines.close();
      if (code !== 0)
        throw new Error(`Native process exited ${code}: ${stderr}`);
    },
  };
};
