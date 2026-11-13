import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { counterFaults } from "../harness/counter-faults.js";
import { digest } from "../usable/provenance.js";
import { fingerprint } from "./provenance.js";
import { executeSuite } from "./runners.js";
import { buildSuite } from "./suite.js";

const phase = process.argv[2];
assert.ok(
  phase === "development" || phase === "confirmation" || phase === "regression",
  "Pass development / confirmation / regression",
);
const directory = process.argv[3];
assert.ok(directory, "Pass a new run directory");
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const write = (name: string, value: unknown) =>
  writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const ledger = async (value: unknown) => {
  if (directory.startsWith("evals/runs/"))
    await appendFile("evals/runs/ledger.jsonl", `${JSON.stringify(value)}\n`);
};
const sources = await fingerprint();
const wasm = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const seeds =
  phase === "development"
    ? [201, 202, 203, 204, 205]
    : Array.from({ length: 10 }, (_, index) => 211 + index);
const parent = process.argv[4];
if (phase === "confirmation") {
  assert.ok(parent, "Confirmation requires the completed development run");
  const previous = JSON.parse(
    await readFile(join(parent, "result.json"), "utf8"),
  );
  const previousManifest = JSON.parse(
    await readFile(join(parent, "manifest.json"), "utf8"),
  );
  assert.equal(previous.status, "complete");
  assert.equal(previous.phase, "development");
  assert.equal(
    previous.sourceVersion,
    sources.sourceVersion,
    "Development and confirmation must use identical sources",
  );
  assert.ok(
    Array.isArray(previousManifest.seeds) &&
      previousManifest.seeds.every((seed: number) => !seeds.includes(seed)),
    "Confirmation seeds overlap development",
  );
}
await write("manifest.json", {
  plan: "0007-shared-oracle",
  phase,
  seeds,
  parent: parent || null,
  ...sources,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean),
  node: process.version,
  go: execFileSync("go", ["version"]).toString().trim(),
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  platform: process.platform,
  arch: process.arch,
  wasmSha256: digest(wasm),
  nativeSha256: digest(
    await readFile(
      "evals/shared-oracle-rust/target/release/modelt-shared-oracle",
    ),
  ),
  goSha256: digest(await readFile(".artifacts/go/counter-replay")),
  startedAt: new Date().toISOString(),
});
const started = performance.now();
try {
  const suite = buildSuite(seeds);
  await write("suite.json", suite);
  const execution = await executeSuite(suite);
  const witnesses = counterFaults.map((fault) => {
    const row = execution.rows.find(
      (entry) => entry.fault === fault && entry.result.status === "mismatch",
    );
    assert.ok(row, `Missing witness for ${fault}`);
    const entry = suite.cases.find((entry) => entry.id === row.caseId);
    assert.ok(entry);
    return { fault, case: entry, result: row.result };
  });
  for (const [fault, steps] of [
    ["persistence", 3],
    ["deduplication", 2],
    ["late-retry", 3],
    ["fifo-only", 5],
    ["drop-ignored", 5],
  ] as const) {
    const row = execution.rows.find(
      (entry) => entry.caseId === fault && entry.fault === fault,
    );
    assert.ok(
      row?.result.status === "mismatch" && row.result.checkedSteps === steps,
      `Regression failed: ${fault}`,
    );
  }
  const matrix = execution.rows.map((row) => ({
    caseId: row.caseId,
    fault: row.fault,
    status: row.result.status,
    checkedSteps: row.result.checkedSteps,
    calls: row.calls,
    resultSha256: digest(JSON.stringify(row.result)),
  }));
  await write("matrix.json", matrix);
  await write("witnesses.json", witnesses);
  const perSeed = seeds.map((seed) => ({
    seed,
    cases: suite.cases.filter((entry) => entry.seed === seed).length,
    faults: counterFaults.map((fault) => ({
      fault,
      detected: execution.rows.filter(
        (row) =>
          row.fault === fault &&
          row.result.status === "mismatch" &&
          suite.cases.some(
            (entry) => entry.id === row.caseId && entry.seed === seed,
          ),
      ).length,
    })),
  }));
  const files = await Promise.all(
    ["manifest.json", "suite.json", "matrix.json", "witnesses.json"].map(
      async (path) => ({
        path,
        sha256: digest(await readFile(join(directory, path))),
      }),
    ),
  );
  const result = {
    status: "complete",
    phase,
    sourceVersion: sources.sourceVersion,
    languages: execution.languages,
    cases: suite.cases.length,
    states: suite.model.states.length,
    edges: suite.model.states.reduce(
      (total, state) => total + state.transitions.length,
      0,
    ),
    normalControls: execution.normalControls,
    comparisons: execution.comparisons,
    mismatchesBetweenLanguages: 0,
    backendDigests: execution.backendDigests,
    witnesses: witnesses.length,
    perSeed,
    elapsedMs: performance.now() - started,
    files,
  };
  await write("result.json", result);
  await ledger({
    runId: directory.split("/").at(-1),
    kind: "shared-oracle",
    phase,
    status: "complete",
    sourceVersion: sources.sourceVersion,
    plan: "0007-shared-oracle",
  });
  console.log(
    JSON.stringify({ ...result, perSeed: undefined, files: undefined }),
  );
} catch (error) {
  await write("error.json", { message: String(error) });
  await ledger({
    runId: directory.split("/").at(-1),
    kind: "shared-oracle",
    phase,
    status: "error",
    sourceVersion: sources.sourceVersion,
    message: String(error),
  });
  throw error;
}
