import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { check } from "tla-ts";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { fingerprint } from "../rust-safety/provenance.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { cases } from "./cases.js";
import { traceInput } from "./tlc.js";
import { type Report, verify } from "./verify.js";

const directory = process.argv[2];
assert.ok(directory, "Pass a new output directory");
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const source = await fingerprint();
const write = (path: string, value: unknown) =>
  writeFile(join(directory, path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
await write("manifest.json", {
  plan: "0012-collections-temporal",
  ...source,
  wasmSha256: digest(bytes),
  node: process.version,
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"]).toString().trim(),
  startedAt: new Date().toISOString(),
});
const core = await createPortableWasm(bytes);
const native = startNative();
const reports: Report[] = [];
try {
  for (const input of cases) reports.push(await verify(input, core, native));
  const normal = reports.find(
    (report) => report.input.name === "eventually-always-WF",
  );
  assert.ok(normal?.outcome.result?.violation);
  const wrongProperty = traceInput(
    normal.input,
    normal.program,
    normal.outcome.result,
    false,
  );
  const control = await check({ ...wrongProperty, livenessCheck: "final" });
  assert.equal(
    control.status,
    "liveness-violation",
    "a witness cannot prove the violated property",
  );
  await write("checks.json", reports);
  await write("controls.json", {
    input: wrongProperty,
    expected: "liveness-violation",
    actual: control.status,
  });
  const files = await Promise.all(
    ["manifest.json", "checks.json", "controls.json"].map(async (path) => ({
      path,
      sha256: digest(await readFile(join(directory, path))),
    })),
  );
  await write("result.json", {
    status: "complete",
    plan: "0012-collections-temporal",
    sourceVersion: source.sourceVersion,
    files,
    cases: reports.length,
    witnesses: reports.filter((report) => report.witness).length,
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({
      runId: basename(directory),
      kind: "collections-temporal",
      status: "complete",
      sourceVersion: source.sourceVersion,
      plan: "0012-collections-temporal",
    })}\n`,
  );
  console.log(
    JSON.stringify({
      directory,
      cases: reports.length,
      witnesses: reports.filter((report) => report.witness).length,
      control: control.status,
    }),
  );
} catch (error) {
  await write("error.json", {
    status: "error",
    message: String(error),
    reports,
  });
  throw error;
} finally {
  await native.close();
}
