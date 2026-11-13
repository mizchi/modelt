import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkConformance } from "../../src/conformance.js";
import { parseFiniteModel } from "../../src/finite.js";
import {
  createPortableWasm,
  toPortableTrace,
  toPortableValue,
} from "../../src/portable.js";
import { benchmarkFinite } from "./benchmark.js";
import {
  createMutexDriver,
  loadMutex,
  mutexModel,
  mutexRegression,
} from "./mutex.js";
import { digest, usableFingerprint } from "./provenance.js";

const input = process.argv[2];
const target = process.argv[3];
if (!input || !target)
  throw new Error("Pass a usable run and a new benchmark directory");
await mkdir(dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
const modelBytes = await readFile(join(input, "model.json"));
const model = parseFiniteModel(JSON.parse(modelBytes.toString()));
const fingerprint = await usableFingerprint();
const wasm = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
await writeFile(
  join(target, "manifest.json"),
  `${JSON.stringify({ plan: "0005-usable-core", kind: "fixed-history-performance", ...fingerprint, input, modelSha256: digest(modelBytes), wasmSha256: digest(wasm), node: process.version, platform: process.platform, arch: process.arch }, null, 2)}\n`,
  { flag: "wx" },
);
try {
  const fixed = await checkConformance(
    mutexModel,
    createMutexDriver(await loadMutex("after")),
    mutexRegression,
  );
  const broken = await checkConformance(
    mutexModel,
    createMutexDriver(await loadMutex("before")),
    mutexRegression,
  );
  assert.equal(fixed.status, "matched");
  assert.equal(broken.status, "mismatch");
  const start = performance.now();
  const core = await createPortableWasm(wasm);
  const wasmStartupMs = performance.now() - start;
  const history = toPortableTrace(fixed.trace);
  const result = await benchmarkFinite(
    model,
    [
      history,
      toPortableTrace(broken.trace),
      {
        ...history,
        steps: [
          {
            action: toPortableValue({ type: "unknown" }),
            observation: toPortableValue(null),
          },
        ],
      },
    ],
    core,
  );
  assert.equal(
    (await usableFingerprint()).sourceVersion,
    fingerprint.sourceVersion,
  );
  await writeFile(
    join(target, "result.json"),
    `${JSON.stringify({ status: "complete", wasmStartupMs, ...result }, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      result.batches.map((batch) => ({
        size: batch.size,
        targets: batch.targets.map((target) => ({
          name: target.name,
          medianMs: target.medianMs,
          perHistoryMs: target.perHistoryMs,
        })),
      })),
    ),
  );
} catch (error) {
  await writeFile(
    join(target, "result.json"),
    `${JSON.stringify({ status: "error", message: error instanceof Error ? error.message : String(error) })}\n`,
    { flag: "wx" },
  );
  throw error;
}
