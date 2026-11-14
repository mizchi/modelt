import { array, constantFrom } from "fast-check";
import { init } from "z3-solver";
import {
  type CounterAction,
  counterModel,
  createCounter,
} from "../examples/durable-counter.js";
import { checkConformance, checkModel, checkTrace } from "../src/index.js";
import { checkSafety, createPortableWasm } from "../src/portable.js";
import { checkProperty } from "../src/property.js";
import { createSmtOracle } from "../src/smt.js";
import { compileTlaSafety, generateTlaOracle } from "../src/tla.js";

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
  const rust = await createPortableWasm(
    new Uint8Array(await (await fetch("/core.wasm")).arrayBuffer()),
  );
  const safety = checkSafety(
    rust,
    compileTlaSafety({
      source:
        "---- MODULE BrowserSafety ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = x + 1\nSafe == x < 3\n====",
      config: "INIT Init\nNEXT Next\nINVARIANT Safe",
    }),
    { maxDepth: 4, maxStates: 5, maxWork: 100 },
  );
  if (
    safety.status !== "invariant-violation" ||
    safety.violation?.trace.length !== 4
  )
    throw new Error("Browser TLA compiler and Rust backend differ");
  const live = checkSafety(
    rust,
    compileTlaSafety({
      source:
        "---- MODULE BrowserLive ----\nEXTENDS Naturals, Sequences\nVARIABLE q\nInit == q = <<0>>\nNext == q' = <<1 - Head(q)>>\nSpec == Init /\\ [][Next]_q /\\ WF_q(Next)\nP == <>[](Head(q) = 1)\n====",
      config: "SPECIFICATION Spec\nPROPERTY P",
    }),
    { maxDepth: 4, maxStates: 10, maxWork: 10000, maxTemporalNodes: 100 },
  );
  if (
    live.status !== "liveness-violation" ||
    live.violation?.loopStart === undefined
  )
    throw new Error("Browser temporal compilation differs");
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
