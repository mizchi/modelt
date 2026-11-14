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
        log: `${reference.log}Error: evaluation`,
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
      log: `${reference.log}Semantic errors`,
    }),
    "input-error",
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

test("initial invariant failures remain valid when TLC omits aggregate counts", () => {
  const reference = {
    status: "invariant-violation",
    exit: 12,
    states: null,
    generated: null,
    log: "TLC2 Version\nStarting...\nError: Invariant Prop is violated by the initial state:\nx = 1\n",
  };
  assert.equal(classifyTlc(reference), "invariant-violation");
  assert.deepEqual(
    differences(
      {
        result: {
          ...result,
          status: "invariant-violation",
          violation: {
            name: "Prop",
            trace: [{ action: null, values: [{ type: "int", value: "1" }] }],
          },
        },
      },
      reference,
    ),
    [],
  );
});

test("a TLC parser crash is infrastructure failure, not rejected model input", () => {
  const log =
    "TLC2 Version\nFatal errors while parsing TLA+ spec\njava.lang.NullPointerException: standard module unavailable\nStarting...\nError: Parsing or semantic analysis failed.";
  assert.equal(
    classifyTlc({
      status: "error",
      exit: 150,
      states: null,
      generated: null,
      log,
    }),
    "infrastructure-error",
  );
});
