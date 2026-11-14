import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check } from "tla-ts";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { fingerprint } from "../rust-safety/provenance.js";
import { startNative } from "../usable/native.js";
import { digest } from "../usable/provenance.js";
import { cases } from "./cases.js";
import { type Report, verify } from "./verify.js";

const directory = process.argv[2];
assert.ok(directory);
const read = async (path: string) =>
  JSON.parse(await readFile(join(directory, path), "utf8"));
const result = await read("result.json");
assert.equal(result.status, "complete");
assert.equal(
  result.sourceVersion,
  (await fingerprint()).sourceVersion,
  "Check out recorded sources before replay",
);
assert.deepEqual(
  result.files.map((file: { path: string }) => file.path).sort(),
  ["checks.json", "controls.json", "manifest.json"],
);
for (const file of result.files)
  assert.equal(file.sha256, digest(await readFile(join(directory, file.path))));
const manifest = await read("manifest.json");
assert.equal(manifest.sourceVersion, result.sourceVersion);
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
assert.equal(manifest.wasmSha256, digest(bytes));
// Digests and the source fingerprint authenticate this experiment's saved schema.
const reports: Report[] = await read("checks.json");
assert.deepEqual(
  reports.map((report) => report.input.name),
  cases.map((input) => input.name),
);
const core = await createPortableWasm(bytes);
const native = startNative();
try {
  for (const report of reports) {
    assert.deepEqual(
      await verify(report.input, core, native),
      report,
      report.input.name,
    );
    if (report.witness) {
      const replay = await check({ ...report.witness, livenessCheck: "final" });
      assert.equal(
        replay.status,
        report.witness.expected === "complete"
          ? "success"
          : report.witness.expected,
      );
      assert.equal(replay.distinctStates, report.witness.states);
    }
  }
  const control = await read("controls.json");
  assert.equal(control.expected, "liveness-violation");
  assert.equal(
    (await check({ ...control.input, livenessCheck: "final" })).status,
    control.expected,
  );
  console.log(
    `${reports.length} saved programs, witnesses and negative control reproduced`,
  );
} finally {
  await native.close();
}
