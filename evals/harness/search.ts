import type { Model } from "../../src/index.js";

export type SearchStrategy = "uniform" | "novelty" | "alternating";

export interface SearchOptions {
  readonly seed: number;
  readonly maxOperations: number;
  readonly maxDepth: number;
}

export interface Corpus<Action> {
  readonly cases: readonly (readonly Action[])[];
  readonly operations: number;
  readonly modelSteps: number;
  readonly states: number;
  readonly edges: number;
}

export const enabledActions = <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  choices: readonly number[],
): readonly Action[] => {
  const initial = model.initial();
  const first = initial[0];
  if (initial.length !== 1 || !first)
    throw new Error("Enabled-input experiment requires one initial state");
  let state = first.state;
  return choices.map((choice) => {
    if (!Number.isSafeInteger(choice) || choice < 0)
      throw new RangeError("Choice must be a nonnegative integer");
    const actions = model.actions(state);
    const action = actions[choice % actions.length];
    if (!action)
      throw new Error("Enabled-input experiment requires enabled actions");
    const successors = model.step(state, action);
    const successor = successors[0];
    if (successors.length !== 1 || !successor)
      throw new Error(
        "Enabled-input experiment requires deterministic transitions",
      );
    state = successor.state;
    return action;
  });
};

export const generateCorpus = <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  strategy: SearchStrategy,
  options: SearchOptions,
): Corpus<Action> => {
  if (
    !Number.isSafeInteger(options.seed) ||
    !Number.isSafeInteger(options.maxOperations) ||
    options.maxOperations < 2 ||
    !Number.isSafeInteger(options.maxDepth) ||
    options.maxDepth < 1
  )
    throw new RangeError("Invalid search budget or seed");
  let randomState = options.seed >>> 0 || 0x9e3779b9;
  const pick = <Value>(values: readonly Value[]): Value => {
    randomState ^= randomState << 13;
    randomState ^= randomState >>> 17;
    randomState ^= randomState << 5;
    const selected =
      values[Math.floor(((randomState >>> 0) / 0x1_0000_0000) * values.length)];
    if (selected === undefined)
      throw new Error("The experiment requires nonempty enabled actions");
    return selected;
  };
  const initial = model.initial();
  const start = initial[0];
  if (initial.length !== 1 || !start)
    throw new Error("Experimental search requires one initial state");
  const states = new Set([model.key(start.state)]);
  const edges = new Set<string>();
  const corpus: { state: State; actions: readonly Action[] }[] = [
    { state: start.state, actions: [] },
  ];
  const cases: Action[][] = [];
  let operations = 0;
  let modelSteps = 0;
  while (options.maxOperations - operations >= 2) {
    const depth = Math.min(
      strategy === "alternating" && cases.length % 2 === 0
        ? Math.max(1, Math.floor(options.maxDepth / 2))
        : options.maxDepth,
      options.maxOperations - operations - 1,
    );
    const prefix =
      strategy === "novelty"
        ? pick(corpus.filter((entry) => entry.actions.length < depth))
        : corpus[0];
    if (!prefix) throw new Error("Missing corpus seed");
    let state = prefix.state;
    const actions = [...prefix.actions];
    const count = strategy === "novelty" ? 1 : depth;
    for (let index = 0; index < count; index++) {
      const action = pick(model.actions(state));
      const successors = model.step(state, action);
      const successor = successors[0];
      if (successors.length !== 1 || !successor)
        throw new Error(
          "Experimental search requires deterministic enabled transitions",
        );
      modelSteps++;
      actions.push(action);
      const edge = JSON.stringify([
        model.key(state),
        action,
        model.key(successor.state),
      ]);
      const novel = !states.has(model.key(successor.state)) || !edges.has(edge);
      states.add(model.key(successor.state));
      edges.add(edge);
      state = successor.state;
      if (strategy === "novelty" && novel)
        corpus.push({ state, actions: [...actions] });
    }
    cases.push(actions);
    operations += 1 + actions.length;
  }
  return {
    cases,
    operations,
    modelSteps,
    states: states.size,
    edges: edges.size,
  };
};
