import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { counterModel } from "../../examples/counter-model.js";
import { isCounterAction } from "../../examples/durable-counter.js";
import { checkConformance } from "../../src/conformance.js";
import { parseFiniteModel } from "../../src/finite.js";
import { parseConcurrentHistory } from "../../src/history.js";
import { toPortableTrace, toPortableValue } from "../../src/portable.js";
import { isRecord } from "../../src/trace.js";
import { executeSuite } from "../cross-language/runners.js";
import { isFault, parseSuite } from "../cross-language/suite.js";
import { createFaultyCounter } from "../harness/counter-faults.js";
import { runScheduledCounter } from "../harness/scheduled-counter.js";
import { digest } from "../usable/provenance.js";
import { compareHistories } from "./histories.js";
import { runPatterns } from "./patterns.js";
import { fingerprint } from "./provenance.js";

const directory = process.argv[2];
assert.ok(directory, "Pass a saved run");
const result = JSON.parse(
  await readFile(join(directory, "result.json"), "utf8"),
);
assert.equal(result.status, "complete");
assert.equal(
  (await fingerprint()).sourceVersion,
  result.sourceVersion,
  "Check out recorded sources before replay",
);
const names = [
  "manifest.json",
  "histories.json",
  "patterns.json",
  "corpora.json",
  "trials.json",
  "witnesses.json",
  "replay-suite.json",
  "shrink.json",
  "benchmark.json",
];
assert.deepEqual(
  result.files.map((file: { path: string }) => file.path).sort(),
  [...names].sort(),
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
const histories: unknown = JSON.parse(
  await readFile(join(directory, "histories.json"), "utf8"),
);
assert.ok(
  isRecord(histories) &&
    isRecord(histories.live) &&
    isRecord(histories.uncertain),
);
for (const group of [histories.live, histories.uncertain]) {
  assert.ok(Array.isArray(group.cases) && Array.isArray(group.results));
  const cases = group.cases.map((entry: unknown) => {
    assert.ok(
      isRecord(entry) &&
        typeof entry.maxNodes === "number" &&
        Number.isSafeInteger(entry.maxNodes),
    );
    return {
      history: parseConcurrentHistory(entry.history),
      maxNodes: entry.maxNodes,
    };
  });
  assert.deepEqual(
    await compareHistories(parseFiniteModel(group.model), cases),
    group.results,
  );
}
const live = histories.live;
assert.ok(
  Array.isArray(live.references) &&
    Array.isArray(live.cases) &&
    live.references.length === live.cases.length,
);
const liveCases: readonly unknown[] = live.cases;
for (const [index, reference] of live.references.entries()) {
  assert.ok(
    isRecord(reference) &&
      typeof reference.broken === "boolean" &&
      Array.isArray(reference.ordering),
  );
  const ordering = reference.ordering.map((value: unknown) => {
    assert.ok(typeof value === "number" && Number.isSafeInteger(value));
    return value;
  });
  const run = await runScheduledCounter(reference.broken, ordering);
  const events = run.history
    .flatMap((operation) => [
      {
        at: operation.call,
        event: {
          kind: "invoke",
          id: operation.id,
          action: toPortableValue(operation.input),
        },
      },
      {
        at: operation.returned,
        event: {
          kind: "return",
          id: operation.id,
          observation: toPortableValue(operation.output),
        },
      },
    ])
    .sort((left, right) => left.at - right.at)
    .map((entry) => entry.event);
  const entry = liveCases[index];
  assert.ok(isRecord(entry) && isRecord(entry.history));
  assert.deepEqual(
    events,
    entry.history.events,
    "Live schedule did not reproduce",
  );
}
const patterns = JSON.parse(
  await readFile(join(directory, "patterns.json"), "utf8"),
);
assert.deepEqual(await runPatterns(), patterns);
const witnesses: unknown = JSON.parse(
  await readFile(join(directory, "witnesses.json"), "utf8"),
);
assert.ok(Array.isArray(witnesses) && witnesses.length > 0);
for (const witness of witnesses) {
  assert.ok(
    isRecord(witness) &&
      isFault(witness.fault) &&
      witness.fault !== "none" &&
      Array.isArray(witness.actions),
  );
  const actions = witness.actions.map((action: unknown) => {
    assert.ok(isCounterAction(action));
    return action;
  });
  const failure = await checkConformance(
    counterModel,
    createFaultyCounter(witness.fault),
    actions,
  );
  assert.equal(failure.status, "mismatch");
  assert.deepEqual(
    {
      ...failure,
      actual: toPortableValue(failure.actual),
      expected: failure.expected.map(toPortableValue),
      trace: toPortableTrace(failure.trace),
    },
    witness.result,
  );
  assert.equal(
    (await checkConformance(counterModel, createFaultyCounter("none"), actions))
      .status,
    "matched",
  );
}
const suite = parseSuite(
  JSON.parse(await readFile(join(directory, "replay-suite.json"), "utf8")),
);
const execution = await executeSuite(suite);
for (const entry of suite.cases)
  assert.equal(
    execution.rows.find(
      (row) => row.caseId === entry.id && row.fault === entry.id,
    )?.result.status,
    "mismatch",
  );
console.log(
  `${witnesses.length} saved failures, 3-language live replay, concurrent histories and fault boundaries reproduced`,
);
