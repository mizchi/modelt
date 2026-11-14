import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { fingerprint } from "../rust-safety/provenance.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { corpus, type Input, seeds } from "./corpus.js";
import { differential, type Report } from "./differential.js";

const [java, jar, phase, directory, parent] = process.argv.slice(2);
assert.ok(
  java &&
    jar &&
    directory &&
    (phase === "development" || phase === "confirmation" || phase === "replay"),
);
const source = await fingerprint();
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const nativePath = "crates/modelt-core/target/release/modelt-core";
const artifacts = {
  wasmSha256: digest(bytes),
  nativeSha256: digest(await readFile(nativePath)),
  jarSha256: digest(await readFile(jar)),
};
let saved: Report[] | undefined;
let inputs: readonly Input[];
if (phase === "replay") {
  assert.ok(parent, "Pass the saved run after the new output directory");
  const result = JSON.parse(
    await readFile(join(parent, "result.json"), "utf8"),
  );
  assert.equal(
    result.sourceVersion,
    source.sourceVersion,
    "Check out recorded sources before replay",
  );
  for (const file of result.files)
    assert.equal(file.sha256, digest(await readFile(join(parent, file.path))));
  const manifest = JSON.parse(
    await readFile(join(parent, "manifest.json"), "utf8"),
  );
  for (const [key, value] of Object.entries(artifacts))
    assert.equal(manifest[key], value);
  inputs = JSON.parse(await readFile(join(parent, "inputs.json"), "utf8"));
  saved = JSON.parse(await readFile(join(parent, "reports.json"), "utf8"));
} else inputs = corpus(phase);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const write = (path: string, value: unknown) =>
  writeFile(join(directory, path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
await write("manifest.json", {
  plan: "0015-tlc-differential",
  phase,
  ...source,
  ...artifacts,
  seed: phase === "replay" ? null : seeds[phase],
  parent: parent ?? null,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  node: process.version,
  startedAt: new Date().toISOString(),
});
await write("inputs.json", inputs);
const core = await createPortableWasm(bytes);
const native = startNative();
const reports: Report[] = [];
try {
  for (const input of inputs) {
    await mkdir(join(directory, input.name), { recursive: false });
    const report = await differential(
      input,
      core,
      native,
      java,
      jar,
      join(directory, input.name),
    );
    reports.push(report);
    console.log(
      input.name,
      report.differences.length
        ? JSON.stringify(report.differences)
        : "matched",
      report.reference.status,
    );
  }
  if (saved)
    assert.deepEqual(reports, saved, "Saved verdicts or witnesses changed");
  assert.equal(
    (await fingerprint()).sourceVersion,
    source.sourceVersion,
    "Sources changed during the run",
  );
  assert.equal(digest(await readFile(nativePath)), artifacts.nativeSha256);
  assert.equal(
    digest(
      await readFile(
        "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
      ),
    ),
    artifacts.wasmSha256,
  );
  assert.equal(digest(await readFile(jar)), artifacts.jarSha256);
  await write("reports.json", reports);
  const files = [];
  for (const path of ["manifest.json", "inputs.json", "reports.json"])
    files.push({ path, sha256: digest(await readFile(join(directory, path))) });
  for (const input of inputs)
    for (const kind of ["model", "witness"]) {
      if (
        kind === "witness" &&
        !reports.find((report) => report.input.name === input.name)?.witness
      )
        continue;
      for (const name of await readdir(join(directory, input.name, kind)))
        if (/\.(tla|cfg|log)$/.test(name)) {
          const path = join(input.name, kind, name);
          files.push({
            path,
            sha256: digest(await readFile(join(directory, path))),
          });
        }
    }
  const mismatches = reports.filter((report) => report.differences.length > 0);
  const infrastructureErrors = reports.filter((report) =>
    report.differences.includes("infrastructure-error"),
  ).length;
  const incomplete = reports.filter((report) =>
    report.differences.some(
      (difference) => difference === "bounded" || difference === "unsupported",
    ),
  ).length;
  const status = infrastructureErrors
    ? "infrastructure-error"
    : incomplete
      ? "incomplete"
      : mismatches.length
        ? "mismatch"
        : "complete";
  const result = {
    status,
    plan: "0015-tlc-differential",
    sourceVersion: source.sourceVersion,
    phase,
    files,
    cases: reports.length,
    matched: reports.filter(
      (report) =>
        report.differences.length === 0 && report.classification === "compared",
    ).length,
    rejectedInputs: reports.filter(
      (report) => report.classification === "rejected-input",
    ).length,
    infrastructureErrors,
    incomplete,
    modelErrors: reports.filter(
      (report) => report.reference.status === "model-error",
    ).length,
    witnesses: reports.filter((report) => report.witness).length,
    mismatches: mismatches.map((report) => ({
      name: report.input.name,
      differences: report.differences,
    })),
  };
  await write("result.json", result);
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "tlc-differential", status, phase, sourceVersion: source.sourceVersion, plan: result.plan })}\n`,
  );
  console.log(
    JSON.stringify({
      directory,
      status,
      cases: result.cases,
      matched: result.matched,
      mismatches: result.mismatches.length,
    }),
  );
  if (status !== "complete") process.exitCode = 1;
} catch (error) {
  await write("error.json", {
    status: "infrastructure-error",
    message: String(error),
    reports,
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "tlc-differential", status: "infrastructure-error", phase, sourceVersion: source.sourceVersion, plan: "0015-tlc-differential" })}\n`,
  );
  throw error;
} finally {
  await native.close();
}
