import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let server: Server | undefined;
let origin: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/runtime-browser-entry.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "runtimeBrowser",
    write: false,
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("No browser runtime bundle");
  const wasm = await readFile(
    "evals/rust-probe/target/wasm32-unknown-unknown/release/modelt_runtime_probe.wasm",
  );
  server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/runtime.wasm"
        ? "application/wasm"
        : request.url === "/bundle.js"
          ? "text/javascript"
          : "text/html",
    );
    response.end(
      request.url === "/runtime.wasm"
        ? wasm
        : request.url === "/bundle.js"
          ? output.contents
          : '<!doctype html><title>modelt Rust runtime</title><script src="/bundle.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing runtime server");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
});
test("executes Rust Wasm, budget planning and sharding in Chromium", async ({
  page,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const api: unknown = Reflect.get(globalThis, "runtimeBrowser");
    if (
      typeof api !== "object" ||
      api === null ||
      !("run" in api) ||
      typeof api.run !== "function"
    )
      throw new Error("No runtime API");
    return api.run();
  });
  expect(result).toMatchObject({
    matched: true,
    states: 56,
    sharding: "complete",
    workers: 1,
    depth: 8,
  });
});
