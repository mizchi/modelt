import { counterModel } from "../examples/counter-model.js";
import { createCounter, isCounterAction } from "../examples/durable-counter.js";
import { checkConformance } from "../src/conformance.js";
import { compileFiniteModel } from "../src/finite.js";
import { createSimulationHost } from "../src/host.js";
import {
  checkFiniteHistories,
  checkPortableConformance,
  checkPortableTrace,
  coreDeletionCandidates,
  createHistoryRecorder,
  createPortableWasm,
  fromPortableValue,
  loadFiniteModel,
  toPortableTrace,
  toPortableValue,
  verifyHostTape,
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
  const finite = compileFiniteModel(counterModel, {
    maxDepth: 20,
    maxStates: 1000,
  });
  if (
    !finite.model ||
    checkFiniteHistories(core, finite.model, [
      toPortableTrace(reference.trace),
    ])[0]?.status !== "matched"
  )
    throw new Error("Browser finite artifact differs");
  if (!coreDeletionCandidates(core, 3).some((range) => range.count === 1))
    throw new Error("Missing browser shrink candidates");
  const loaded = loadFiniteModel(core, finite.model);
  const history = createHistoryRecorder(
    counterModel.name,
    toPortableValue(reference.trace.initial),
  );
  for (const [index, step] of reference.trace.steps.entries()) {
    history.invoke(String(index), toPortableValue(step.action));
    history.returned(String(index), toPortableValue(step.observation));
  }
  if (
    loaded.checkHistory(history.snapshot(), 100).status !== "linearizable" ||
    loaded.checkHistories([toPortableTrace(reference.trace)])[0]?.status !==
      "matched"
  )
    throw new Error("Browser loaded history differs");
  loaded.release();
  const host = createSimulationHost({ seed: 3 });
  host.write("value", 1);
  host.persist();
  host.write("value", 2);
  host.crash();
  host.restart();
  if (host.read("value") !== 1)
    throw new Error("Browser storage recovery differs");
  if (
    JSON.stringify(verifyHostTape(core, host.trace())) !==
    JSON.stringify(
      toPortableValue({
        clock: 0,
        running: true,
        storage: { value: 1 },
        pending: [],
      }),
    )
  )
    throw new Error("Rust browser host replay differs");
  return {
    normal: normal.status,
    broken: broken.status,
    replay: replay.status,
    steps: broken.checkedSteps,
    isolated: globalThis.crossOriginIsolated,
  };
};
