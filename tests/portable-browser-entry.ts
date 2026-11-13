import { counterModel } from "../examples/counter-model.js";
import { createCounter, isCounterAction } from "../examples/durable-counter.js";
import { checkConformance } from "../src/conformance.js";
import {
  checkPortableConformance,
  checkPortableTrace,
  createPortableWasm,
  fromPortableValue,
  toPortableTrace,
  toPortableValue,
} from "../src/portable.js";

export const run = async (): Promise<Record<string, unknown>> => {
  const core = await createPortableWasm(
    new Uint8Array(await (await fetch("/core.wasm")).arrayBuffer()),
  );
  const actions = [
    { type: "add", id: "a", amount: 1 },
    { type: "crash" },
    { type: "restart" },
  ] as const;
  const reference = await checkConformance(
    counterModel,
    createCounter(),
    actions,
  );
  const normal = await checkPortableConformance(
    core,
    counterModel,
    createCounter(),
    actions,
  );
  const broken = await checkPortableConformance(
    core,
    counterModel,
    createCounter({ persist: false }),
    actions,
  );
  const replay = await checkPortableTrace(
    core,
    toPortableTrace(reference.trace),
    createCounter({ persist: false }),
    (value) => {
      const action = fromPortableValue(value);
      if (!isCounterAction(action)) throw new Error("Invalid portable action");
      return action;
    },
  );
  const value = toPortableValue({
    integer: 9007199254740993123456789n,
    set: new Set([2, 1, 2]),
    map: new Map([["😀", new Uint8Array([255])]]),
  });
  const result = core.request({
    version: 1,
    request: { kind: "canonicalize", value },
  });
  if (
    result.kind !== "value" ||
    JSON.stringify(result.value) !== JSON.stringify(value)
  )
    throw new Error("Browser value semantics differ");
  return {
    normal: normal.status,
    broken: broken.status,
    replay: replay.status,
    steps: broken.checkedSteps,
    isolated: globalThis.crossOriginIsolated,
  };
};
