import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyTlc, differences } from "./compare.js";
import { boundaries, graphs, seeds } from "./corpus.js";

const reference = {
  status: "complete",
  exit: 0,
  states: 1,
  generated: 2,
  log: "TLC2 Version\nStarting...\n",
};
const result = {
  status: "complete",
  reason: null,
  states: 1,
  generated: 2,
  depth: 0,
  work: 3,
  violation: null,
} as const;
test("TLC differences reject count mismatches and incomplete checking", () => {
  assert.deepEqual(differences({ result }, reference), []);
  assert.equal(
    differences({ result: { ...result, states: 2 } }, reference).length,
    1,
  );
  assert.deepEqual(
    differences(
      { result: { ...result, status: "bounded", reason: "work" } },
      reference,
    ),
    ["bounded"],
  );
  assert.deepEqual(
    differences(
      { error: { phase: "compile", code: "protocol", message: "unsupported" } },
      {
        ...reference,
        status: "error",
        exit: 255,
        log: reference.log + "Error: evaluation",
      },
    ),
    ["unsupported"],
  );
});
test("JVM and syntax failures cannot count as matching model errors", () => {
  const error = {
    phase: "check",
    code: "protocol",
    message: "model failed",
  } as const;
  assert.equal(
    classifyTlc({
      ...reference,
      status: "error",
      exit: 1,
      log: "Error: Could not find main class",
    }),
    "infrastructure-error",
  );
  assert.equal(
    classifyTlc({
      ...reference,
      status: "error",
      exit: 150,
      log: reference.log + "Semantic errors",
    }),
    "infrastructure-error",
  );
  assert.deepEqual(
    differences({ error }, { ...reference, status: "error", exit: null }),
    ["infrastructure-error"],
  );
});
test("development and confirmation graphs have distinct fixed inputs", () => {
  const development = graphs(seeds.development);
  const confirmation = graphs(seeds.confirmation);
  assert.equal(development.length, 32);
  assert.equal(confirmation.length, 32);
  assert.deepEqual(graphs(seeds.development), development);
  assert.equal(
    new Set([...development, ...confirmation].map((input) => input.source))
      .size,
    64,
  );
  assert.equal(
    new Set(boundaries().map((input) => input.name)).size,
    boundaries().length,
  );
});
