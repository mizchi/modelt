import assert from "node:assert/strict";
import {
  array,
  assert as assertProperty,
  asyncProperty,
  constant,
  constantFrom,
  integer,
} from "fast-check";
import {
  type CounterAction,
  counterModel,
  createCounter,
} from "../examples/durable-counter.js";
import { checkDifferential } from "../src/index.js";
import { checkProperty } from "../src/property.js";

export const counterActions = array(
  constantFrom<CounterAction>(
    { type: "add", id: "a", amount: 1 },
    { type: "add", id: "b", amount: 2 },
    { type: "crash" },
    { type: "restart" },
  ),
  { maxLength: 24 },
);

export const registerPropertyContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("property tests generate valid action sequences for a conforming implementation", async () => {
    const result = await checkProperty(
      counterModel,
      createCounter,
      counterActions,
      { seed: 42, numRuns: 100 },
    );
    assert.equal(result.status, "passed");
    assert.equal(result.numRuns, 100);
  });
  test("shrunk fault traces replay from seed and path", async () => {
    const result = await checkProperty(
      counterModel,
      () => createCounter({ persist: false }),
      counterActions,
      { seed: 42, numRuns: 200 },
    );
    assert.equal(result.status, "failed");
    assert.ok(result.counterexample);
    assert.ok(result.path !== undefined);
    assert.equal(result.counterexample.length, 3);
    assert.deepEqual(
      result.counterexample.map((action) => action.type),
      ["add", "crash", "restart"],
    );
    const replay = await checkProperty(
      counterModel,
      () => createCounter({ persist: false }),
      counterActions,
      { seed: result.seed, path: result.path, numRuns: 200 },
    );
    assert.deepEqual(replay.counterexample, result.counterexample);
    assert.equal(result.failure?.status, "mismatch");
  });
  test("discarding every generated input is exhaustion, never a passing test", async () => {
    const result = await checkProperty(
      { ...counterModel, step: () => [] },
      createCounter,
      constant<readonly CounterAction[]>([{ type: "crash" }]),
      { seed: 1, numRuns: 1, maxSkipsPerRun: 2 },
    );
    assert.equal(result.status, "exhausted");
    assert.equal(result.numRuns, 0);
  });
  test("property testing propagates infrastructure errors", async () => {
    await assert.rejects(
      checkProperty(
        counterModel,
        () => ({
          reset: () => {
            throw new Error("setup failed");
          },
          step: () => ({ running: true, value: 0 }),
        }),
        counterActions,
        { seed: 42, numRuns: 1 },
      ),
      /setup failed/,
    );
  });
  test("request renaming is a metamorphic relation independent of the model", async () => {
    await assertProperty(
      asyncProperty(counterActions, integer(), async (actions, salt) => {
        const renamed = createCounter();
        const result = await checkDifferential(
          createCounter(),
          {
            reset: renamed.reset,
            step: (action: CounterAction) =>
              renamed.step(
                action.type === "add"
                  ? { ...action, id: `${salt}:${action.id}` }
                  : action,
              ),
          },
          actions,
        );
        assert.equal(result.status, "matched");
      }),
      { seed: 73, numRuns: 50 },
    );
  });
};
