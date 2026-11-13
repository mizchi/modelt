import type { Model, Trace, Transition } from "./contracts.js";

export interface ExplorationBounds {
  readonly maxDepth: number;
  readonly maxStates: number;
}

export interface ExplorationResult<Action, Observation> {
  readonly status: "complete" | "bounded" | "violation" | "empty";
  readonly states: number;
  readonly edges: number;
  readonly traces: readonly Trace<Action, Observation>[];
  readonly violation?: {
    readonly invariant: string;
    readonly trace: Trace<Action, Observation>;
  };
}

export const checkModel = <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  bounds: ExplorationBounds,
): ExplorationResult<Action, Observation> => {
  if (
    !Number.isSafeInteger(bounds.maxDepth) ||
    bounds.maxDepth < 0 ||
    !Number.isSafeInteger(bounds.maxStates) ||
    bounds.maxStates < 1
  ) {
    throw new RangeError(
      "Expected maxDepth >= 0 and maxStates >= 1 as safe integers",
    );
  }
  const queue: {
    entry: Transition<State, Observation>;
    trace: Trace<Action, Observation>;
  }[] = [];
  const visited = new Set<string>();
  const traces: Trace<Action, Observation>[] = [];
  let edges = 0;
  let bounded = false;
  const accept = (
    entry: Transition<State, Observation>,
    trace: Trace<Action, Observation>,
  ): ExplorationResult<Action, Observation> | undefined => {
    traces.push(trace);
    const invariant = model.invariants?.find(
      (property) => !property.check(entry.state),
    );
    if (invariant)
      return {
        status: "violation",
        states: visited.size,
        edges,
        traces,
        violation: { invariant: invariant.name, trace },
      };
    const key = model.key(entry.state);
    if (visited.has(key)) return;
    if (visited.size === bounds.maxStates) {
      bounded = true;
      return;
    }
    visited.add(key);
    queue.push({ entry, trace });
  };
  for (const entry of model.initial()) {
    const violation = accept(entry, {
      version: 1,
      model: model.name,
      initial: entry.observation,
      steps: [],
    });
    if (violation) return violation;
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!current) continue;
    for (const action of model.actions(current.entry.state)) {
      for (const successor of model.step(current.entry.state, action)) {
        if (current.trace.steps.length === bounds.maxDepth) {
          if (!visited.has(model.key(successor.state))) bounded = true;
          continue;
        }
        edges++;
        const violation = accept(successor, {
          ...current.trace,
          steps: [
            ...current.trace.steps,
            { action, observation: successor.observation },
          ],
        });
        if (violation) return violation;
      }
    }
  }
  return {
    status: visited.size === 0 ? "empty" : bounded ? "bounded" : "complete",
    states: visited.size,
    edges,
    traces,
  };
};
