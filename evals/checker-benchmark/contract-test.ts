import assert from "node:assert/strict";
import { test } from "node:test";
import { cases, order, summarize, verify } from "./protocol.js";

test("benchmark refuses partial exploration, missing counts, and different graphs", () => {
  const expected = { states: 128, generated: 129 };
  const complete = { status: "complete", ...expected, violation: null };
  assert.deepEqual(verify(complete, expected), expected);
  for (const invalid of [
    { ...complete, status: "bounded" },
    { ...complete, status: "empty" },
    { ...complete, states: 127 },
    { ...complete, generated: 128 },
    { ...complete, violation: { name: "P" } },
    { status: "complete", states: 128 },
  ])
    assert.throws(() => verify(invalid, expected));
});

test("summary preserves all measured samples and reports median and range", () => {
  assert.deepEqual(summarize([9, 2, 5, 3, 1, 7, 4]), {
    median: 4,
    min: 1,
    max: 9,
  });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([Number.NaN]));
});

test("fixed corpus has known generated counts and source-based million-state ring", () => {
  const corpus = cases();
  assert.equal(corpus.length, 11);
  assert.equal(new Set(corpus.map((input) => input.name)).size, 11);
  assert.deepEqual(
    corpus.map((input) => [input.states, input.generated]),
    [
      [4096, 49153],
      [4096, 49153],
      [2047, 3071],
      [128, 129],
      [10000, 10001],
      [50000, 50001],
      [100000, 100001],
      [400, 801],
      [2500, 5001],
      [10000, 20001],
      [1000000, 1000001],
    ],
  );
  assert.match(corpus[10]?.config ?? "", /CONSTANT N = 1000000/);
  assert.equal(corpus[10]?.source, corpus[4]?.source);
});

test("routes rotate without missing or duplicating an engine", () => {
  const routes = ["tla-ts", "tlc", "wasm", "native"];
  assert.deepEqual(order(routes, 1), ["tlc", "wasm", "native", "tla-ts"]);
  assert.deepEqual(order(routes, 4), routes);
});
