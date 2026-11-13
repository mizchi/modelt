import assert from "node:assert/strict";
import type { Model, PortableTrace } from "../../src/contracts.js";
import { toPortableTrace } from "../../src/portable.js";

export const createOracle = <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  actions: readonly Action[],
): PortableTrace => {
  const first = model.initial()[0];
  assert.ok(first);
  let current = first.state;
  return toPortableTrace({
    version: 1,
    model: model.name,
    initial: first.observation,
    steps: actions.map((action) => {
      const successors = model.step(current, action);
      assert.equal(successors.length, 1);
      const next = successors[0];
      assert.ok(next);
      current = next.state;
      return { action, observation: next.observation };
    }),
  });
};
