import assert from "node:assert/strict";
import {
  type CounterAction,
  counterModel,
} from "../../examples/counter-model.js";
import { createCounter } from "../../examples/durable-counter.js";
import { checkModel } from "../../src/checker.js";
import { composeModels } from "../../src/compose.js";
import { checkConformance } from "../../src/conformance.js";
import type { Model } from "../../src/contracts.js";
import { compileFiniteModel } from "../../src/finite.js";
import {
  checkConcurrentHistory,
  createHistoryRecorder,
} from "../../src/history.js";
import { createSimulationHost } from "../../src/host.js";
import { fromPortableValue, toPortableValue } from "../../src/portable.js";

interface CreditState {
  readonly epoch: number;
  readonly value: number;
}
type LeaseAction =
  | { readonly kind: "advance"; readonly amount: number }
  | { readonly kind: "write" };

export const runPatterns = async () => {
  const credit = compileFiniteModel<CreditState, string, number | null>(
    {
      name: "credit",
      initial: () => [{ state: { epoch: 1, value: 0 }, observation: 0 }],
      key: (state) => JSON.stringify([state.epoch, state.value]),
      actions: (state) => [
        `credit:${state.epoch}`,
        "read",
        ...(state.epoch === 1 ? ["crash"] : []),
      ],
      step: (state, action) =>
        action === `credit:${state.epoch}`
          ? [{ state: { ...state, value: 1 }, observation: 1 }]
          : action === "read"
            ? [{ state, observation: state.value }]
            : action === "crash" && state.epoch === 1
              ? [{ state: { ...state, epoch: 2 }, observation: null }]
              : [],
    },
    { maxDepth: 4, maxStates: 4 },
  );
  assert.ok(credit.model);
  const crash = [];
  for (const cut of [
    "before",
    "value-only",
    "seen-only",
    "committed",
  ] as const) {
    for (const split of [false, true]) {
      const host = createSimulationHost();
      const history = createHistoryRecorder("credit", toPortableValue(0));
      history.invoke("first", toPortableValue("credit:1"));
      if (cut !== "before") {
        if (!split || cut !== "seen-only") host.write("value", 1);
        if (!split || cut !== "value-only") host.write("seen", true);
        host.persist();
      }
      history.end("first", "unknown");
      history.invoke("fault", toPortableValue("crash"));
      host.crash();
      host.restart();
      history.returned("fault", toPortableValue(null));
      history.invoke("read", toPortableValue("read"));
      history.returned("read", toPortableValue(host.read("value") ?? 0));
      history.invoke("retry", toPortableValue("credit:2"));
      const previous = host.read("value") ?? 0;
      assert.ok(typeof previous === "number");
      const value = host.read("seen") === true ? previous : previous + 1;
      host.write("value", value);
      host.write("seen", true);
      host.persist();
      history.returned("retry", toPortableValue(value));
      const result = checkConcurrentHistory(
        credit.model,
        history.snapshot(),
        100,
      );
      assert.equal(
        result.status,
        split && (cut === "value-only" || cut === "seen-only")
          ? "not-linearizable"
          : "linearizable",
      );
      crash.push({ cut, split, result, history: history.snapshot() });
    }
  }
  for (const split of [false, true]) {
    const host = createSimulationHost();
    const history = createHistoryRecorder("credit", toPortableValue(0));
    history.invoke("first", toPortableValue("credit:1"));
    host.write("value", 1);
    host.write("seen", true);
    if (!split) host.persist();
    history.returned("first", toPortableValue(1));
    history.invoke("fault", toPortableValue("crash"));
    host.crash();
    host.restart();
    history.returned("fault", toPortableValue(null));
    history.invoke("read", toPortableValue("read"));
    history.returned("read", toPortableValue(host.read("value") ?? 0));
    const result = checkConcurrentHistory(
      credit.model,
      history.snapshot(),
      100,
    );
    assert.equal(result.status, split ? "not-linearizable" : "linearizable");
    crash.push({
      cut: "ack-before-persist",
      split,
      result,
      history: history.snapshot(),
    });
  }
  const fencing = [];
  for (const broken of [false, true]) {
    let host = createSimulationHost();
    let epoch = 1;
    const model = {
      name: "fencing",
      initial: () => [
        {
          state: 1,
          observation: { epoch: 1, accepted: null as boolean | null },
        },
      ],
      key: String,
      actions: (state: number) => (state === 1 ? ["rotate"] : ["old-write"]),
      step: (_state: number, action: string) =>
        action === "rotate"
          ? [
              {
                state: 2,
                observation: { epoch: 2, accepted: null as boolean | null },
              },
            ]
          : [{ state: 2, observation: { epoch: 2, accepted: false } }],
    };
    const result = await checkConformance(
      model,
      {
        reset: () => {
          host = createSimulationHost();
          epoch = 1;
          host.send("old-leader", "storage", { epoch: 1 });
          return { epoch, accepted: null as boolean | null };
        },
        step: (action) => {
          if (action === "rotate") {
            host.advance(6);
            epoch++;
            return { epoch, accepted: null as boolean | null };
          }
          const request = host.deliver(0);
          const payload = fromPortableValue(request.payload);
          assert.ok(
            typeof payload === "object" &&
              payload !== null &&
              "epoch" in payload,
          );
          return { epoch, accepted: broken || payload.epoch === epoch };
        },
      },
      ["rotate", "old-write"],
    );
    assert.equal(result.status, broken ? "mismatch" : "matched");
    fencing.push({ broken, result, tape: host.trace() });
  }
  const recovery = [];
  const leases = [];
  const leaseModel: Model<number, LeaseAction, boolean | null> = {
    name: "lease",
    initial: () => [{ state: 0, observation: null }],
    key: String,
    actions: (state) => [
      { kind: "write" },
      ...[4, 5, 6]
        .filter((time) => time > state)
        .map(
          (time): LeaseAction => ({ kind: "advance", amount: time - state }),
        ),
    ],
    step: (state, action) =>
      action.kind === "advance"
        ? [{ state: state + action.amount, observation: null }]
        : [{ state, observation: state < 5 }],
  };
  for (const time of [4, 5, 6])
    for (const broken of [false, true]) {
      let host = createSimulationHost();
      const result = await checkConformance<
        number,
        LeaseAction,
        boolean | null
      >(
        leaseModel,
        {
          reset: () => {
            host = createSimulationHost();
            return null;
          },
          step: (action) => {
            if (action.kind === "advance") {
              host.advance(action.amount);
              return null;
            }
            return broken ? host.now() <= 5 : host.now() < 5;
          },
        },
        [{ kind: "advance", amount: time }, { kind: "write" }],
      );
      assert.equal(
        result.status,
        broken && time === 5 ? "mismatch" : "matched",
      );
      leases.push({ time, broken, result, tape: host.trace() });
    }
  for (const stalled of [false, true]) {
    const host = createSimulationHost();
    host.send("a", "b", "work");
    // Faults stop; the bounded policy offers every queued delivery within three ticks.
    for (let tick = 0; tick < 3; tick++) {
      host.advance(1);
      if (!stalled && host.pending().length) host.deliver(0);
    }
    const status = host.pending().length === 0 ? "recovered" : "inconclusive";
    assert.equal(status, stalled ? "inconclusive" : "recovered");
    recovery.push({ stalled, status, tape: host.trace() });
  }
  const bit = {
    name: "bit",
    initial: () => [{ state: 0, observation: 0 }],
    key: String,
    actions: (state: number) => (state === 0 ? [1] : []),
    step: (_state: number, action: number) => [
      { state: action, observation: action },
    ],
  };
  const combined = composeModels(bit, bit, {
    name: "cross-resource",
    invariants: [
      {
        name: "shared-capacity",
        check: (state) => state.left.state + state.right.state <= 1,
      },
    ],
  });
  const composition = checkModel(combined, { maxDepth: 2, maxStates: 4 });
  assert.equal(composition.status, "violation");
  assert.equal(
    checkModel(bit, { maxDepth: 2, maxStates: 4 }).status,
    "complete",
  );
  const guarded = {
    ...combined,
    step: (
      state: Parameters<typeof combined.step>[0],
      action: Parameters<typeof combined.step>[1],
    ) =>
      combined
        .step(state, action)
        .filter(
          (entry) => entry.state.left.state + entry.state.right.state <= 1,
        ),
  };
  assert.equal(
    checkModel(guarded, { maxDepth: 2, maxStates: 4 }).status,
    "complete",
  );
  const queue = {
    name: "queue",
    initial: () => [
      {
        state: { pending: 0, delivered: false },
        observation: { pending: 0, delivered: false },
      },
    ],
    key: (state: { pending: number; delivered: boolean }) =>
      JSON.stringify(state),
    actions: (state: { pending: number; delivered: boolean }) => [
      ...(state.pending < 2 ? ["send"] : []),
      ...(state.pending > 0 ? ["deliver", "drop"] : []),
    ],
    step: (state: { pending: number; delivered: boolean }, action: string) => {
      const next = {
        pending: state.pending + (action === "send" ? 1 : -1),
        delivered: state.delivered || action === "deliver",
      };
      return [{ state: next, observation: next }];
    },
  };
  const storage = {
    name: "storage",
    initial: () => [{ state: 0, observation: 0 }],
    key: String,
    actions: () => ["a"],
    step: () => [{ state: 1, observation: 1 }],
  };
  const product = composeModels(queue, storage, {
    name: "queue-storage",
    sharedActions: (state) =>
      state.left.state.pending > 0 ? [{ left: "deliver", right: "a" }] : [],
    invariants: [
      {
        name: "no-phantom-credit",
        check: (state) =>
          state.right.state === Number(state.left.state.delivered),
      },
    ],
  });
  const bound = {
    ...product,
    actions: (state: Parameters<typeof product.actions>[0]) =>
      product
        .actions(state)
        .filter(
          (action) =>
            action.target === "both" ||
            (action.target === "left" && action.action !== "deliver"),
        ),
  };
  assert.equal(
    checkModel(bound, { maxDepth: 10, maxStates: 20 }).status,
    "complete",
  );
  const queueStorage = [];
  for (const duplicate of [false, true]) {
    const implementation = createCounter({ deduplicate: !duplicate });
    let pending: string[] = [];
    let delivered = false;
    let value = 0;
    const observe = () => ({
      left: { pending: pending.length, delivered },
      right: value,
    });
    const result = await checkConformance(
      bound,
      {
        reset: async () => {
          pending = [];
          delivered = false;
          value = (await implementation.reset()).value;
          return observe();
        },
        step: async (action) => {
          if (action.target === "left" && action.action === "send")
            pending.push("a");
          else if (action.target === "left" && action.action === "drop")
            pending.shift();
          else if (action.target === "both") {
            const id = pending.shift();
            assert.ok(id);
            delivered = true;
            value = (await implementation.step({ type: "add", id, amount: 1 }))
              .value;
          } else throw new Error("Invalid queue/storage binding");
          return observe();
        },
      },
      [
        { target: "left", action: "send" },
        { target: "left", action: "send" },
        { target: "both", left: "deliver", right: "a" },
        { target: "both", left: "deliver", right: "a" },
      ],
    );
    assert.equal(result.status, duplicate ? "mismatch" : "matched");
    queueStorage.push({ duplicate, result });
  }
  const original: readonly CounterAction[] = [
    { type: "add", id: "a", amount: 1 },
    { type: "add", id: "b", amount: 1 },
    { type: "crash" },
    { type: "restart" },
    { type: "add", id: "a", amount: 1 },
  ];
  const renamed = original.map((action) =>
    action.type === "add" || action.type === "send"
      ? { ...action, id: action.id === "a" ? "b" : "a" }
      : action,
  );
  const swapped = [original[1], original[0], ...original.slice(2)].filter(
    (action) => action !== undefined,
  );
  const normal = await checkConformance(
    counterModel,
    createCounter(),
    original,
  );
  for (const actions of [renamed, swapped]) {
    const result = await checkConformance(
      counterModel,
      createCounter(),
      actions,
    );
    assert.equal(result.status, "matched");
    assert.deepEqual(result.actual, normal.actual);
  }
  const duplicate: readonly CounterAction[] = [
    { type: "add", id: "a", amount: 1 },
    { type: "add", id: "a", amount: 1 },
  ];
  const weak = {
    ...counterModel,
    step: (
      state: Parameters<typeof counterModel.step>[0],
      action: CounterAction,
    ) =>
      counterModel.step(state, action).flatMap((edge) => [
        edge,
        {
          ...edge,
          observation: {
            ...edge.observation,
            value: edge.observation.value + 1,
          },
        },
      ]),
  };
  const strong = await checkConformance(
    counterModel,
    createCounter({ deduplicate: false }),
    duplicate,
  );
  const permissive = await checkConformance(
    weak,
    createCounter({ deduplicate: false }),
    duplicate,
  );
  assert.equal(strong.status, "mismatch");
  assert.equal(permissive.status, "matched");
  return {
    creditModel: credit.model,
    crash,
    fencing,
    recovery,
    leases,
    composition,
    queueStorage,
    metamorphic: 2,
    weakModelAcceptedBug: true,
    modelAdequacy: { actions: duplicate, strong, permissive },
  };
};
