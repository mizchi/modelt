import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { cases } from "../evals/collections-temporal/cases.js";
import { compileTlaSafety } from "../src/tla-safety.js";

let server: Server | undefined;
let origin: string;
test.beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["tests/portable-browser-entry.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    globalName: "portableBrowser",
    write: false,
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("Missing portable browser bundle");
  const wasm = await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  );
  const safety = JSON.stringify(
    compileTlaSafety({
      source:
        "---- MODULE BrowserSafety ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = x + 1\nSafe == x < 3\n====",
      config: "INIT Init\nNEXT Next\nINVARIANT Safe",
    }),
  );
  const complex = JSON.stringify(
    cases
      .filter((input) =>
        [
          "set-fault",
          "function-updates",
          "sequence-queue",
          "multiple-eventualities",
          "SF-intermittent",
          "temporal-node-cut",
        ].includes(input.name),
      )
      .map((input) => ({
        program: compileTlaSafety(input),
        bounds: input.bounds,
        expected: input.expected,
      })),
  );
  server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/core.wasm"
        ? "application/wasm"
        : request.url === "/bundle.js"
          ? "text/javascript"
          : request.url === "/safety.json" || request.url === "/complex.json"
            ? "application/json"
            : "text/html",
    );
    response.end(
      request.url === "/core.wasm"
        ? wasm
        : request.url === "/bundle.js"
          ? output.contents
          : request.url === "/safety.json"
            ? safety
            : request.url === "/complex.json"
              ? complex
              : '<!doctype html><title>modelt portable core</title><script src="/bundle.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing server address");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
});
test("runs the shared Rust core in Chromium without host imports or cross-origin isolation", async ({
  page,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const api: unknown = Reflect.get(globalThis, "portableBrowser");
    if (
      typeof api !== "object" ||
      api === null ||
      !("run" in api) ||
      typeof api.run !== "function"
    )
      throw new Error("Missing portable browser API");
    return api.run();
  });
  expect(result).toEqual({
    normal: "matched",
    broken: "mismatch",
    replay: "mismatch",
    steps: 3,
    isolated: false,
  });
});
