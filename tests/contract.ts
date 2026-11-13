import assert from "node:assert/strict";
import {
  type CounterAction,
  counterModel,
  createCounter,
  isCounterAction,
  isCounterObservation,
} from "../examples/durable-counter.js";
import {
  checkConformance,
  checkModel,
  checkTrace,
  decodeTrace,
  encodeTrace,
} from "../src/index.js";

export const registerContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("a durable implementation conforms through retries, crashes and restarts", async () => {
    const result = await checkConformance(counterModel, createCounter(), [
      { type: "add", id: "a", amount: 2 },
      { type: "crash" },
      { type: "restart" },
      { type: "add", id: "a", amount: 2 },
    ]);
    assert.equal(result.status, "matched");
    assert.equal(result.checkedSteps, 4);
  });

  test("a volatile write loses an acknowledged value after a crash", async () => {
    const result = await checkConformance(
      counterModel,
      createCounter({ persist: false }),
      [
        { type: "add", id: "a", amount: 2 },
        { type: "crash" },
        { type: "restart" },
      ],
    );
    assert.equal(result.status, "mismatch");
    assert.equal(result.checkedSteps, 3);
    assert.deepEqual(result.actual, { running: true, value: 0 });
    assert.deepEqual(result.expected, [{ running: true, value: 2 }]);
  });

  test("a missing deduplication check applies a retried request twice", async () => {
    const actions: CounterAction[] = [
      { type: "add", id: "a", amount: 1 },
      { type: "add", id: "a", amount: 1 },
    ];
    const result = await checkConformance(
      counterModel,
      createCounter({ deduplicate: false }),
      actions,
    );
    assert.equal(result.status, "mismatch");
    assert.equal(result.checkedSteps, 2);
  });

  test("oracle generation gives replayable witnesses and distinguishes a depth bound", async () => {
    const oracle = checkModel(counterModel, { maxDepth: 2, maxStates: 100 });
    assert.equal(oracle.status, "bounded");
    assert.ok(oracle.traces.length > 1);
    for (const trace of oracle.traces) {
      assert.equal(
        (await checkTrace(trace, createCounter())).status,
        "matched",
      );
    }
  });

  test("trace artifacts survive a JSON round trip", async () => {
    const oracle = checkModel(counterModel, { maxDepth: 1, maxStates: 100 });
    const trace = oracle.traces.at(-1);
    assert.ok(trace);
    const decoded = decodeTrace(encodeTrace(trace), {
      action: isCounterAction,
      observation: isCounterObservation,
    });
    assert.deepEqual(decoded, trace);
    assert.equal(
      (await checkTrace(decoded, createCounter())).status,
      "matched",
    );
  });

  test("driver errors propagate instead of counting as a detected mismatch", async () => {
    await assert.rejects(
      checkConformance(
        counterModel,
        {
          reset: () => ({ running: true, value: 0 }),
          step: () => {
            throw new Error("driver disconnected");
          },
        },
        [{ type: "crash" }],
      ),
      /driver disconnected/,
    );
  });
};
