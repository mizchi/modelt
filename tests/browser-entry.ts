import { array, constantFrom } from "fast-check";
import { init } from "z3-solver";
import {
  type CounterAction,
  counterModel,
  createCounter,
} from "../examples/durable-counter.js";
import { checkConformance, checkModel, checkTrace } from "../src/index.js";
import { checkProperty } from "../src/property.js";
import { createSmtOracle } from "../src/smt.js";
import { generateTlaOracle } from "../src/tla.js";

export const run = async (): Promise<Record<string, unknown>> => {
  const model = checkModel(counterModel, { maxDepth: 2, maxStates: 100 });
  const trace = model.traces.at(-1);
  if (!trace) throw new Error("No browser oracle trace");
  const replay = await checkTrace(trace, createCounter());
  const property = await checkProperty(
    counterModel,
    () => createCounter({ persist: false }),
    array(
      constantFrom<CounterAction>(
        { type: "add", id: "a", amount: 1 },
        { type: "crash" },
        { type: "restart" },
      ),
      { maxLength: 20 },
    ),
    { seed: 42, numRuns: 100 },
  );
  const tla = await generateTlaOracle(
    {
      source:
        "---- MODULE Browser ----\nEXTENDS Naturals\nVARIABLE value\nInit == value = 0\nNext == value' = value + 1\nSafe == value < 2\n====",
      config: "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
    },
    {
      name: "browser-tla",
      observation: (step) => step.state.value,
      action: () => "increment",
    },
  );
  const api = await init({ locateFile: (path) => `/${path}` });
  const smt = await createSmtOracle(api).solve(
    "(declare-const value Int) (assert (= value 7))",
    ["value"],
  );
  const conformance = await checkConformance(counterModel, createCounter(), [
    { type: "add", id: "wasm", amount: Number(smt.values.value) },
  ]);
  return {
    model: model.status,
    replay: replay.status,
    property: property.status,
    shrunk: property.counterexample?.length,
    tla: tla.check.status,
    tlaSteps: tla.trace?.steps.length,
    smt,
    conformance: conformance.status,
    isolated: globalThis.crossOriginIsolated,
  };
};
