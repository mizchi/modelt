import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check } from "tla-ts";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { benchmarkCases } from "./cases.js";
import { fingerprint } from "./provenance.js";

const directory = process.argv[2];
assert.ok(directory);
const result = JSON.parse(
  await readFile(join(directory, "result.json"), "utf8"),
);
assert.equal(result.status, "complete");
assert.equal(
  (await fingerprint()).sourceVersion,
  result.sourceVersion,
  "Check out recorded sources before replay",
);
assert.deepEqual(
  result.files.map((file: { path: string }) => file.path).sort(),
  ["benchmark.json", "manifest.json"],
);
for (const file of result.files)
  assert.equal(
    digest(await readFile(join(directory, file.path))),
    file.sha256,
    `Changed evidence: ${file.path}`,
  );
const manifest = JSON.parse(
  await readFile(join(directory, "manifest.json"), "utf8"),
);
assert.equal(manifest.sourceVersion, result.sourceVersion);
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
assert.equal(digest(bytes), manifest.wasmSha256);
const core = await createPortableWasm(bytes);
const native = startNative();
try {
  const reports: unknown = JSON.parse(
    await readFile(join(directory, "benchmark.json"), "utf8"),
  );
  assert.ok(Array.isArray(reports));
  assert.equal(reports.length, result.cases);
  assert.deepEqual(
    reports.map((report) => report.name),
    benchmarkCases().map((input) => input.name),
  );
  for (const report of reports) {
    assert.ok(
      isRecord(report) &&
        isRecord(report.input) &&
        typeof report.input.source === "string" &&
        typeof report.input.config === "string",
    );
    const program = compileTlaSafety({
      source: report.input.source,
      config: report.input.config,
    });
    assert.deepEqual(program, report.program);
    const bounds = { maxDepth: 1000000, maxStates: 1000000, maxWork: 10000000 };
    const actual = checkSafety(core, program, bounds);
    const response = await native.request({
      version: 1,
      request: { kind: "check-safety", program, bounds },
    });
    assert.deepEqual(response, { kind: "safety", result: actual });
    const reference = await check({
      source: report.input.source,
      config: report.input.config,
      workers: 1,
    });
    assert.equal(reference.status, "success");
    assert.equal(actual.status, "complete");
    assert.equal(actual.states, reference.distinctStates);
    assert.equal(actual.generated, reference.generatedStates);
    assert.equal(actual.states, report.input.states);
  }
  console.log(
    `${reports.length} saved TLA programs reproduced in tla-ts, Rust native and Wasm`,
  );
} finally {
  await native.close();
}
