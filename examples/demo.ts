import { mkdir, writeFile } from "node:fs/promises";
import { array, constantFrom } from "fast-check";
import { init, killThreads } from "z3-solver";
import {
  checkDifferential,
  checkModel,
  checkTrace,
  encodeTrace,
} from "../src/index.js";
import { checkProperty } from "../src/property.js";
import { createSmtOracle } from "../src/smt.js";
import { generateTlaOracle } from "../src/tla.js";
import {
  type CounterAction,
  counterModel,
  createCounter,
} from "./durable-counter.js";

const oracle = checkModel(counterModel, { maxDepth: 4, maxStates: 500 });
for (const trace of oracle.traces) {
  if ((await checkTrace(trace, createCounter())).status !== "matched")
    throw new Error("Model witness failed to replay");
}
console.log("model", {
  status: oracle.status,
  states: oracle.states,
  edges: oracle.edges,
  replayedWitnesses: oracle.traces.length,
});

const property = await checkProperty(
  counterModel,
  () => createCounter({ persist: false }),
  array(
    constantFrom<CounterAction>(
      { type: "add", id: "a", amount: 1 },
      { type: "add", id: "b", amount: 2 },
      { type: "crash" },
      { type: "restart" },
    ),
    { maxLength: 24 },
  ),
  { seed: 42, numRuns: 200 },
);
console.log("property", {
  status: property.status,
  seed: property.seed,
  path: property.path,
  shrinks: property.numShrinks,
  actions: property.counterexample,
});

const differential = await checkDifferential(
  createCounter(),
  createCounter({ deduplicate: false }),
  [
    { type: "add", id: "retry", amount: 1 },
    { type: "add", id: "retry", amount: 1 },
  ],
);
console.log("differential", {
  status: differential.status,
  actual: differential.actual,
  expected: differential.expected,
});

const tla = await generateTlaOracle(
  {
    source:
      "---- MODULE Demo ----\nEXTENDS Naturals\nVARIABLE value\nInit == value = 0\nNext == value' = value + 1\nSafe == value < 2\n====",
    config: "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
  },
  {
    name: "tla-counter",
    observation: (step) => step.state.value,
    action: () => "increment",
  },
);
console.log("tla", {
  status: tla.check.status,
  witnessSteps: tla.trace?.steps.length,
});

const api = await init();
try {
  const solution = await createSmtOracle(api).solve(
    "(set-logic QF_LIA) (declare-const amount Int) (assert (and (> amount 6) (< amount 8)))",
    ["amount"],
  );
  console.log("smt", solution);
} finally {
  await killThreads(api.em);
}

await mkdir(".artifacts", { recursive: true });
const trace = oracle.traces.at(-1);
if (trace) await writeFile(".artifacts/oracle.json", encodeTrace(trace));
await writeFile(
  ".artifacts/counterexample.json",
  JSON.stringify(property, null, 2),
);
if (tla.trace)
  await writeFile(".artifacts/tla-oracle.json", encodeTrace(tla.trace));
