import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { checkConformance } from "../../src/conformance.js";
import { createSimulationHost } from "../../src/host.js";
import {
  createPortableWasm,
  toPortableTrace,
  toPortableValue,
  verifyHostTape,
} from "../../src/portable.js";
import { isRecord } from "../../src/trace.js";
import {
  createMutexDriver,
  isMutexAction,
  loadMutex,
  mutexModel,
} from "./mutex.js";
import { usableFingerprint } from "./provenance.js";
import { exerciseHost } from "./scenario.js";

const target = process.argv[2];
if (!target) throw new Error("Pass a usable evaluation run");
const manifest = JSON.parse(
  await readFile(join(target, "manifest.json"), "utf8"),
);
assert.equal(
  (await usableFingerprint()).sourceVersion,
  manifest.sourceVersion,
  "Check out the recorded source before replay",
);
const before = await loadMutex("before");
const after = await loadMutex("after");
const witnesses: unknown = JSON.parse(
  await readFile(join(target, "witnesses.json"), "utf8"),
);
assert.ok(Array.isArray(witnesses) && witnesses.length > 0);
for (const witness of witnesses) {
  assert.ok(isRecord(witness) && Array.isArray(witness.actions));
  const actions = witness.actions.map((action: unknown) => {
    assert.ok(isMutexAction(action));
    return action;
  });
  const result = await checkConformance(
    mutexModel,
    createMutexDriver(before),
    actions,
  );
  assert.deepEqual(
    {
      ...result,
      actual: toPortableValue(result.actual),
      expected: result.expected.map(toPortableValue),
      trace: toPortableTrace(result.trace),
    },
    witness.result,
  );
  assert.equal(result.status, "mismatch");
  assert.equal(
    (await checkConformance(mutexModel, createMutexDriver(after), actions))
      .status,
    "matched",
  );
}
const host = JSON.parse(await readFile(join(target, "host.json"), "utf8"));
assert.deepEqual(
  exerciseHost(createSimulationHost({ replay: host.tape })),
  host.snapshot,
);
const core = await createPortableWasm(
  await readFile(
    "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
  ),
);
assert.deepEqual(
  verifyHostTape(core, host.tape),
  toPortableValue({
    clock: 10,
    running: true,
    storage: { counter: 1 },
    pending: [],
  }),
);
console.log(
  `${witnesses.length} historical witnesses and host tape replayed; fixed revision passed`,
);
