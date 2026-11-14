import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import { cases } from "../evals/rust-safety/cases.js";
import { compileTlaSafety } from "../src/tla-safety.js";

let server: Server;
let origin: string;
test.beforeAll(async () => {
  const outputs = await Promise.all([
    build({
      entryPoints: ["evals/parallel-safety/browser-test-entry.ts"],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "parallelSafety",
      write: false,
    }),
    build({
      entryPoints: ["evals/parallel-safety/browser-worker.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    }),
    build({
      entryPoints: ["src/scheduling.ts"],
      bundle: true,
      platform: "browser",
      write: false,
      metafile: true,
    }),
  ]);
  expect(Object.keys(outputs[2]?.metafile?.inputs ?? {})).toEqual([
    "src/scheduling.ts",
  ]);
  const programs = cases
    .filter((input) =>
      ["cycle", "violation", "empty", "depth-cut"].includes(input.name),
    )
    .map((input) => ({ id: input.name, program: compileTlaSafety(input) }));
  const jobs = programs.map((entry) => ({
    id: entry.id,
    program: entry.id,
    estimatedMs: 1,
    memoryBytes: 1024,
    bounds: {
      maxDepth: entry.id === "depth-cut" ? 1 : 100,
      maxStates: 1000,
      maxWork: 100000,
    },
  }));
  const assets = new Map([
    [
      "/bundle.js",
      {
        body: outputs[0]?.outputFiles[0]?.contents ?? new Uint8Array(),
        type: "text/javascript",
      },
    ],
    [
      "/worker.js",
      {
        body: outputs[1]?.outputFiles[0]?.contents ?? new Uint8Array(),
        type: "text/javascript",
      },
    ],
    [
      "/setup.json",
      {
        body: Buffer.from(JSON.stringify({ backend: "wasm", programs, jobs })),
        type: "application/json",
      },
    ],
    [
      "/core.wasm",
      {
        body: await readFile(
          "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
        ),
        type: "application/wasm",
      },
    ],
  ]);
  server = createServer((request, response) => {
    const asset = assets.get(request.url ?? "/");
    response.setHeader("Content-Type", asset?.type ?? "text/html");
    response.end(
      asset?.body ??
        '<!doctype html><title>parallel safety</title><script src="/bundle.js"></script>',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing browser server");
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
});
test("reuses two Wasm workers without cross-origin isolation", async ({
  page,
}) => {
  await page.goto(origin);
  const result = await page.evaluate(async () => {
    const api: unknown = Reflect.get(globalThis, "parallelSafety");
    if (
      typeof api !== "object" ||
      api === null ||
      !("run" in api) ||
      typeof api.run !== "function"
    )
      throw new Error("Missing pool API");
    return api.run();
  });
  expect(result.isolated).toBe(false);
  expect(result.first.executionStatus).toBe("complete");
  expect(result.second.completed).toEqual(result.first.completed);
  expect(
    result.first.completed
      .map(
        (entry: { result: { result: { status: string } } }) =>
          entry.result.result.status,
      )
      .sort(),
  ).toEqual(["bounded", "complete", "empty", "invariant-violation"]);
  expect(result.exhausted.executionStatus).toBe("partial");
  expect(result.exhausted.remaining).toHaveLength(4);
});
