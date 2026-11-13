import assert from "node:assert/strict";
import {
  counterModel,
  createCounter,
  isCounterAction,
  isCounterObservation,
} from "../examples/durable-counter.js";
import {
  checkConformance,
  checkDifferential,
  checkModel,
  checkTrace,
  composeModels,
  decodeTrace,
  encodeTrace,
  equalValues,
  type Model,
} from "../src/index.js";

export const registerAdvancedContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("dropped messages are removed before a later delivery", async () => {
    const result = await checkConformance(counterModel, createCounter(), [
      { type: "send", id: "lost", amount: 10 },
      { type: "drop", index: 0 },
      { type: "send", id: "kept", amount: 2 },
      { type: "deliver", index: 0 },
    ]);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.actual, { running: true, value: 2 });
  });

  test("reset clears request deduplication and durable state between cases", async () => {
    const driver = createCounter();
    const actions = [{ type: "add" as const, id: "a", amount: 1 }];
    assert.equal(
      (await checkConformance(counterModel, driver, actions)).status,
      "matched",
    );
    assert.equal(
      (await checkConformance(counterModel, driver, actions)).status,
      "matched",
    );
    const restarted = await checkConformance(counterModel, driver, [
      { type: "crash" },
      { type: "restart" },
      ...actions,
    ]);
    assert.equal(restarted.status, "matched");
  });

  test("restarting a running process preserves volatile state", async () => {
    const result = await checkConformance(
      counterModel,
      createCounter({ persist: false }),
      [{ type: "add", id: "a", amount: 1 }, { type: "restart" }],
    );
    assert.equal(result.status, "matched");
  });

  test("the trace boundary accepts supported actions and rejects malformed JSON domains", () => {
    for (const value of [
      { type: "add", id: "a", amount: 1 },
      { type: "send", id: "a", amount: 1 },
      { type: "deliver", index: 0 },
      { type: "drop", index: 1 },
      { type: "crash" },
      { type: "restart" },
    ])
      assert.equal(isCounterAction(value), true);
    for (const value of [
      null,
      false,
      1,
      {},
      { type: "other" },
      { type: "other", id: "a", amount: 1 },
      { type: "add", amount: 1 },
      { type: "add", id: 1, amount: 1 },
      { type: "add", id: "a" },
      { type: "add", id: "a", amount: "1" },
      { type: "add", id: "a", amount: 0.1 },
      { type: "deliver" },
      { type: "deliver", index: "0" },
      { type: "deliver", index: -1 },
      { type: "deliver", index: 0.1 },
    ])
      assert.equal(isCounterAction(value), false, JSON.stringify(value));
    assert.equal(isCounterObservation({ running: false, value: 0 }), true);
    for (const value of [
      null,
      false,
      {},
      { running: 1, value: 0 },
      { running: true, value: "0" },
      { running: true, value: 0.1 },
    ])
      assert.equal(isCounterObservation(value), false);
  });

  test("successful reports and replay expose the complete observation record", async () => {
    const result = await checkConformance(counterModel, createCounter(), [
      { type: "add", id: "a", amount: 1 },
    ]);
    assert.deepEqual(result.expected, [{ running: true, value: 1 }]);
    let disposed = false;
    const driver = createCounter();
    const replay = await checkTrace(result.trace, {
      ...driver,
      dispose: () => {
        disposed = true;
      },
    });
    assert.equal(replay.status, "matched");
    assert.deepEqual(replay.trace, result.trace);
    assert.deepEqual(replay.expected, result.expected);
    assert.equal(disposed, true);
    const wrong = await checkTrace(result.trace, {
      reset: () => ({ running: false, value: 9 }),
      step: driver.step,
    });
    assert.deepEqual(wrong.expected, [result.trace.initial]);
  });

  test("differential execution disposes the reference and names its observation record", async () => {
    let disposed = false;
    const reference = createCounter();
    const result = await checkDifferential(
      {
        ...reference,
        dispose: () => {
          disposed = true;
        },
      },
      createCounter(),
      [{ type: "crash" }],
    );
    assert.equal(result.status, "matched");
    assert.equal(result.trace.model, "differential");
    assert.equal(disposed, true);
  });
  test("delayed, reordered and dropped network messages remain replayable", async () => {
    const result = await checkConformance(counterModel, createCounter(), [
      { type: "send", id: "a", amount: 2 },
      { type: "send", id: "b", amount: 3 },
      { type: "deliver", index: 1 },
      { type: "crash" },
      { type: "restart" },
      { type: "drop", index: 0 },
      { type: "add", id: "b", amount: 3 },
    ]);
    assert.equal(result.status, "matched");
    assert.deepEqual(result.actual, { running: true, value: 3 });
  });

  test("a differential oracle detects an implementation regression", async () => {
    const result = await checkDifferential(
      createCounter(),
      createCounter({ deduplicate: false }),
      [
        { type: "add", id: "a", amount: 1 },
        { type: "add", id: "a", amount: 1 },
      ],
    );
    assert.equal(result.status, "mismatch");
    assert.deepEqual(result.expected, [{ running: true, value: 1 }]);
  });

  const finite: Model<number, number, number> = {
    name: "finite",
    initial: () => [{ state: 0, observation: 0 }],
    key: String,
    actions: () => [1],
    step: (state, action) => [
      {
        state: Math.min(2, state + action),
        observation: Math.min(2, state + action),
      },
    ],
  };

  test("finite graph closure, state limits and empty initial states are distinct", () => {
    assert.equal(
      checkModel(finite, { maxDepth: 3, maxStates: 3 }).status,
      "complete",
    );
    assert.equal(
      checkModel(finite, { maxDepth: 3, maxStates: 1 }).status,
      "bounded",
    );
    assert.equal(
      checkModel(
        { ...finite, initial: () => [] },
        { maxDepth: 3, maxStates: 3 },
      ).status,
      "empty",
    );
    assert.throws(
      () => checkModel(finite, { maxDepth: -1, maxStates: 3 }),
      RangeError,
    );
  });

  test("model invariants return a shortest in-bound counterexample", () => {
    const model = {
      ...finite,
      invariants: [{ name: "below-two", check: (state: number) => state < 2 }],
    };
    assert.equal(
      checkModel(model, { maxDepth: 1, maxStates: 10 }).status,
      "bounded",
    );
    const result = checkModel(model, { maxDepth: 2, maxStates: 10 });
    assert.equal(result.status, "violation");
    assert.equal(result.violation?.invariant, "below-two");
    assert.equal(result.violation?.trace.steps.length, 2);
  });

  test("conformance keeps one consistent nondeterministic history", async () => {
    const model: Model<number, string, number> = {
      name: "branches",
      initial: () => [
        { state: 0, observation: 0 },
        { state: 10, observation: 0 },
      ],
      key: String,
      actions: () => ["tick"],
      step: (state) => [{ state: state + 1, observation: state < 10 ? 1 : 2 }],
    };
    let step = 0;
    const result = await checkConformance(
      model,
      { reset: () => 0, step: () => ++step },
      ["tick", "tick"],
    );
    assert.equal(result.status, "mismatch");
    assert.equal(result.checkedSteps, 2);
    assert.deepEqual(result.expected, [1]);
    assert.equal(
      (
        await checkConformance(model, { reset: () => 0, step: () => 2 }, [
          "tick",
          "tick",
        ])
      ).status,
      "matched",
    );
  });

  test("invalid inputs and initial observations cannot pass vacuously", async () => {
    const driver = {
      reset: () => 0,
      step: () => {
        throw new Error("must not run");
      },
    };
    assert.equal(
      (await checkConformance({ ...finite, step: () => [] }, driver, [1]))
        .status,
      "invalid",
    );
    assert.equal(
      (await checkConformance({ ...finite, initial: () => [] }, driver, []))
        .status,
      "invalid",
    );
    assert.equal(
      (await checkConformance(finite, { ...driver, reset: () => 99 }, []))
        .status,
      "mismatch",
    );
  });

  test("driver cleanup runs when stepping fails", async () => {
    let disposed = false;
    await assert.rejects(
      checkConformance(
        finite,
        {
          reset: () => 0,
          step: () => {
            throw new Error("I/O failed");
          },
          dispose: () => {
            disposed = true;
          },
        },
        [1],
      ),
      /I\/O failed/,
    );
    assert.equal(disposed, true);
  });

  test("trace replay checks the initial observation before any action", async () => {
    const trace = checkModel(finite, { maxDepth: 0, maxStates: 3 }).traces[0];
    assert.ok(trace);
    const result = await checkTrace(trace, { reset: () => 99, step: () => 1 });
    assert.equal(result.status, "mismatch");
    assert.equal(result.checkedSteps, 0);
  });

  test("trace decoding validates the caller's action and observation domains", () => {
    const guards = {
      action: isCounterAction,
      observation: isCounterObservation,
    };
    assert.throws(() => decodeTrace('{"version":2}', guards), /Invalid trace/);
    assert.throws(
      () =>
        decodeTrace(
          JSON.stringify({
            version: 1,
            model: "counter",
            initial: { running: true, value: 0 },
            steps: [
              { action: { type: "send", amount: "bad" }, observation: 0 },
            ],
          }),
          guards,
        ),
      /Invalid trace step/,
    );
    assert.throws(
      () =>
        encodeTrace({ version: 1, model: "bigint", initial: 1n, steps: [] }),
      /encode bigint/,
    );
    assert.throws(() => equalValues(new Set([1]), {}), /plain JSON/);
    assert.equal(equalValues({ b: 2, a: [1] }, { a: [1], b: 2 }), true);
    assert.equal(
      equalValues({ ä: 1, "a\u0308": 2 }, { "a\u0308": 2, ä: 1 }),
      true,
    );
  });

  test("composed models expose interleavings and cross-component invariant failures", () => {
    const product = composeModels(finite, finite, {
      name: "product",
      invariants: [
        {
          name: "sum-at-most-two",
          check: (state) => state.left.state + state.right.state <= 2,
        },
      ],
    });
    const result = checkModel(product, { maxDepth: 4, maxStates: 20 });
    assert.equal(result.status, "violation");
    assert.equal(result.violation?.invariant, "sum-at-most-two");
    assert.equal(result.violation?.trace.steps.length, 3);
  });

  test("shared actions advance both components and preserve component invariants", () => {
    const left = {
      ...finite,
      invariants: [{ name: "below-two", check: (state: number) => state < 2 }],
    };
    const product = composeModels(left, finite, {
      name: "shared",
      sharedActions: () => [{ left: 1, right: 1 }],
    });
    const initial = product.initial()[0];
    assert.ok(initial);
    const successor = product.step(initial.state, {
      target: "both",
      left: 1,
      right: 1,
    });
    assert.deepEqual(
      successor.map((entry) => entry.observation),
      [{ left: 1, right: 1 }],
    );
    assert.ok(
      product.actions(initial.state).some((action) => action.target === "both"),
    );
    const result = checkModel(product, { maxDepth: 3, maxStates: 20 });
    assert.equal(result.violation?.invariant, "finite/below-two");
  });
};
