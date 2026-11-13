import type {
  CounterAction,
  CounterState,
} from "../../examples/counter-model.js";
import { counterModel } from "../../examples/counter-model.js";
import type { Corpus, SearchOptions } from "../harness/search.js";

const features = (
  state: CounterState,
  prefix: readonly CounterAction[],
  action: CounterAction,
): readonly string[] => {
  const previous = prefix.at(-1);
  const before = prefix.at(-2);
  return [
    `pair:${previous?.type ?? "initial"}:${action.type}`,
    `triple:${before?.type ?? "initial"}:${previous?.type ?? "initial"}:${action.type}`,
    `running:${state.running}:${action.type}`,
    ...(action.type === "deliver" || action.type === "drop"
      ? [
          `queue:${action.type}:${action.index}:${state.pending.length}`,
          `duplicate:${action.type}:${state.committed.some((entry) => entry.id === state.pending[action.index]?.id)}`,
        ]
      : []),
    ...(action.type === "add" || action.type === "send"
      ? [
          `attempt:${action.type}:${Math.min(3, prefix.filter((entry) => (entry.type === "add" || entry.type === "send") && entry.id === action.id).length)}`,
          `committed:${action.type}:${state.committed.some((entry) => entry.id === action.id)}`,
        ]
      : []),
  ];
};

export const generateFeedbackCorpus = (
  options: SearchOptions,
): Corpus<CounterAction> & {
  readonly features: number;
  readonly featureCalls: number;
} => {
  if (
    !Number.isSafeInteger(options.seed) ||
    !Number.isSafeInteger(options.maxOperations) ||
    options.maxOperations < 2 ||
    !Number.isSafeInteger(options.maxDepth) ||
    options.maxDepth < 1
  )
    throw new RangeError("Invalid feedback budget or seed");
  let random = options.seed >>> 0 || 0x9e3779b9;
  const next = () => {
    random ^= random << 13;
    random ^= random >>> 17;
    random ^= random << 5;
    return (random >>> 0) / 0x1_0000_0000;
  };
  const covered = new Set<string>();
  const states = new Set<string>();
  const edges = new Set<string>();
  const cases: CounterAction[][] = [];
  let operations = 0;
  let modelSteps = 0;
  let featureCalls = 0;
  while (options.maxOperations - operations >= 2) {
    const first = counterModel.initial()[0];
    if (!first) throw new Error("Missing counter initial state");
    let state = first.state;
    const prefix: CounterAction[] = [];
    const depth = Math.min(
      cases.length % 2 === 0
        ? Math.max(1, Math.floor(options.maxDepth / 2))
        : options.maxDepth,
      options.maxOperations - operations - 1,
    );
    for (let index = 0; index < depth; index++) {
      const choices = counterModel.actions(state).map((action) => {
        featureCalls++;
        const keys = features(state, prefix, action);
        return {
          action,
          keys,
          score: keys.filter((key) => !covered.has(key)).length,
        };
      });
      const best = Math.max(...choices.map((choice) => choice.score));
      const candidates =
        next() < 0.25
          ? choices
          : choices.filter((choice) => choice.score === best);
      const chosen = candidates[Math.floor(next() * candidates.length)];
      if (!chosen) throw new Error("Missing enabled feedback action");
      const successors = counterModel.step(state, chosen.action);
      const successor = successors[0];
      if (successors.length !== 1 || !successor)
        throw new Error("Feedback requires deterministic enabled actions");
      for (const key of chosen.keys) covered.add(key);
      states.add(counterModel.key(state));
      edges.add(
        JSON.stringify([
          counterModel.key(state),
          chosen.action,
          counterModel.key(successor.state),
        ]),
      );
      state = successor.state;
      states.add(counterModel.key(state));
      prefix.push(chosen.action);
      modelSteps++;
    }
    cases.push(prefix);
    operations += 1 + prefix.length;
  }
  return {
    cases,
    operations,
    modelSteps,
    states: states.size,
    edges: edges.size,
    features: covered.size,
    featureCalls,
  };
};
