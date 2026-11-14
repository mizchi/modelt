import assert from "node:assert/strict";
import {
  type CounterAction,
  counterModel,
} from "../../examples/counter-model.js";
import { isCounterAction } from "../../examples/durable-counter.js";
import { checkConformance } from "../../src/conformance.js";
import { fromPortableValue } from "../../src/portable.js";
import { shrinkCounterexample } from "../../src/shrink.js";
import { buildSuite } from "../cross-language/suite.js";
import { createFaultyCounter } from "../harness/counter-faults.js";

export const shrinkComparison = async () => {
  const source = buildSuite([]).cases.find((entry) => entry.id === "fifo-only");
  assert.ok(source);
  const actions = source.oracle.steps.map((step) => {
    const action = fromPortableValue(step.action);
    assert.ok(isCounterAction(action));
    return action;
  });
  const reports = [];
  for (const mode of ["deletion", "causal"] as const) {
    let sutOperations = 0;
    let invalid = 0;
    let preflights = 0;
    const enabled = (actions: readonly CounterAction[]) => {
      preflights++;
      const first = counterModel.initial()[0];
      assert.ok(first);
      let state = first.state;
      for (const action of actions) {
        const next = counterModel.step(state, action)[0];
        if (!next) return false;
        state = next.state;
      }
      return true;
    };
    const dependencies = (actions: readonly CounterAction[]) => {
      const pending: number[] = [];
      const edges: { producer: number; consumer: number }[] = [];
      for (const [index, action] of actions.entries()) {
        if (action.type === "send") pending.push(index);
        else if (action.type === "deliver" || action.type === "drop") {
          const producer = pending.splice(action.index, 1)[0];
          if (producer !== undefined) edges.push({ producer, consumer: index });
        }
      }
      return edges;
    };
    const started = performance.now();
    const result = await shrinkCounterexample(
      actions,
      async (candidate) => {
        const implementation = createFaultyCounter("fifo-only");
        const checked = await checkConformance(
          counterModel,
          {
            reset: () => {
              sutOperations++;
              return implementation.reset();
            },
            step: (action) => {
              sutOperations++;
              return implementation.step(action);
            },
          },
          candidate,
        );
        if (checked.status === "invalid") invalid++;
        return checked.status === "mismatch"
          ? { status: "mismatch", signature: "fifo-only" }
          : { status: checked.status };
      },
      {
        maxChecks: 100,
        ...(mode === "causal" ? { isEnabled: enabled, dependencies } : {}),
      },
    );
    assert.notEqual(result.status, "not-failing");
    assert.equal(
      (
        await checkConformance(
          counterModel,
          createFaultyCounter("fifo-only"),
          result.actions,
        )
      ).status,
      "mismatch",
    );
    assert.equal(
      (
        await checkConformance(
          counterModel,
          createFaultyCounter("none"),
          result.actions,
        )
      ).status,
      "matched",
    );
    reports.push({
      mode,
      result,
      sutOperations,
      invalid,
      preflights,
      elapsedMs: performance.now() - started,
    });
  }
  return reports;
};
