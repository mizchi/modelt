import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { counterModel } from "../../examples/counter-model.js";
import { isCounterAction } from "../../examples/durable-counter.js";
import {
  checkPortableConformance,
  createPortableWasm,
} from "../../src/portable.js";
import { isRecord } from "../../src/trace.js";
import {
  counterFaults,
  createFaultyCounter,
} from "../harness/counter-faults.js";
import { portableFingerprint } from "./provenance.js";

const target = process.argv[2];
if (!target) throw new Error("Pass a portable evaluation run directory");
const manifest = JSON.parse(
  await readFile(join(target, "manifest.json"), "utf8"),
);
assert.equal(
  (await portableFingerprint()).sourceVersion,
  manifest.sourceVersion,
  "Run source differs; check out the recorded source before replay",
);
const core = await createPortableWasm(
  await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  ),
);
const witnesses: unknown = JSON.parse(
  await readFile(join(target, "witnesses.json"), "utf8"),
);
assert.ok(
  Array.isArray(witnesses) && witnesses.length === counterFaults.length,
);
for (const witness of witnesses) {
  assert.ok(
    isRecord(witness) &&
      typeof witness.fault === "string" &&
      Array.isArray(witness.actions),
  );
  const fault = counterFaults.find((entry) => entry === witness.fault);
  assert.ok(fault);
  const actions = witness.actions.map((action: unknown) => {
    assert.ok(isCounterAction(action));
    return action;
  });
  const broken = await checkPortableConformance(
    core,
    counterModel,
    createFaultyCounter(fault),
    actions,
  );
  const normal = await checkPortableConformance(
    core,
    counterModel,
    createFaultyCounter("none"),
    actions,
  );
  assert.deepEqual(broken, witness.result);
  assert.equal(broken.status, "mismatch");
  assert.equal(normal.status, "matched");
}
console.log(
  `${witnesses.length} saved faults reproduced; all normal controls passed`,
);
