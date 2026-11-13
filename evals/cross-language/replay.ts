import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePortableResult } from "../../src/portable-wasm.js";
import { isRecord } from "../../src/trace.js";
import { counterFaults } from "../harness/counter-faults.js";
import { digest } from "../usable/provenance.js";
import { fingerprint } from "./provenance.js";
import { executeSuite } from "./runners.js";
import { isFault, parseSuite } from "./suite.js";

const directory = process.argv[2];
assert.ok(directory, "Pass a saved run");
const result = JSON.parse(
  await readFile(join(directory, "result.json"), "utf8"),
);
assert.equal(result.status, "complete", "Incomplete shared oracle run");
assert.equal(
  (await fingerprint()).sourceVersion,
  result.sourceVersion,
  "Check out the recorded sources before replay",
);
assert.ok(Array.isArray(result.files) && result.files.length === 4);
assert.deepEqual(
  result.files.map((file: { path: string }) => file.path).sort(),
  ["manifest.json", "matrix.json", "suite.json", "witnesses.json"],
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
assert.equal(
  digest(
    await readFile(
      "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
    ),
  ),
  manifest.wasmSha256,
  "Use the recorded core Wasm",
);
const suite = parseSuite(
  JSON.parse(await readFile(join(directory, "suite.json"), "utf8")),
);
const witnesses: unknown = JSON.parse(
  await readFile(join(directory, "witnesses.json"), "utf8"),
);
assert.ok(
  Array.isArray(witnesses) && witnesses.length === counterFaults.length,
);
const selected = witnesses.map((witness: unknown) => {
  assert.ok(
    isRecord(witness) &&
      isFault(witness.fault) &&
      witness.fault !== "none" &&
      isRecord(witness.case),
  );
  const savedCase = witness.case;
  const entry = suite.cases.find((entry) => entry.id === savedCase.id);
  assert.ok(entry);
  assert.deepEqual(
    entry,
    savedCase,
    "Witness must retain the saved model oracle",
  );
  return {
    fault: witness.fault,
    case: entry,
    result: decodePortableResult(witness.result),
  };
});
assert.equal(
  new Set(selected.map((entry) => entry.fault)).size,
  counterFaults.length,
);
const replay = await executeSuite({
  ...suite,
  cases: selected
    .map((entry) => entry.case)
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.id === entry.id) === index,
    ),
});
for (const witness of selected) {
  const row = replay.rows.find(
    (entry) =>
      entry.caseId === witness.case.id && entry.fault === witness.fault,
  );
  assert.ok(row);
  assert.equal(row.result.status, "mismatch");
  assert.deepEqual(row.result, witness.result);
}
console.log(
  `${selected.length} saved model oracles reproduced faults in TS / Rust / Go; normal implementations passed`,
);
