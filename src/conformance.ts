import type {
  Comparison,
  ConformanceResult,
  Driver,
  Model,
  Trace,
} from "./contracts.js";
import { equalValues } from "./trace.js";

export const checkConformance = async <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  driver: Driver<Action, Observation>,
  actions: readonly Action[],
  comparison: Comparison<Observation> = {},
): Promise<ConformanceResult<Action, Observation>> => {
  const equal = comparison.equal ?? equalValues;
  try {
    const initial = model.initial();
    const actualInitial = await driver.reset();
    const trace: Trace<Action, Observation> = {
      version: 1,
      model: model.name,
      initial: actualInitial,
      steps: [],
    };
    const candidates = new Map(
      initial
        .filter((entry) => equal(entry.observation, actualInitial))
        .map((entry) => [model.key(entry.state), entry.state]),
    );
    if (candidates.size === 0) {
      return {
        status: initial.length === 0 ? "invalid" : "mismatch",
        checkedSteps: 0,
        actual: actualInitial,
        expected: initial.map((entry) => entry.observation),
        trace,
      };
    }
    const steps: { action: Action; observation: Observation }[] = [];
    const getTrace = (): Trace<Action, Observation> => ({
      ...trace,
      steps: [...steps],
    });
    let actual = actualInitial;
    for (const action of actions) {
      const successors = Array.from(candidates.values()).flatMap((state) =>
        model.step(state, action),
      );
      if (successors.length === 0) {
        return {
          status: "invalid",
          checkedSteps: steps.length,
          actual,
          expected: [],
          trace: getTrace(),
        };
      }
      actual = await driver.step(action);
      steps.push({ action, observation: actual });
      candidates.clear();
      for (const entry of successors) {
        if (equal(entry.observation, actual))
          candidates.set(model.key(entry.state), entry.state);
      }
      if (candidates.size === 0) {
        return {
          status: "mismatch",
          checkedSteps: steps.length,
          actual,
          expected: successors.map((entry) => entry.observation),
          trace: getTrace(),
        };
      }
    }
    return {
      status: "matched",
      checkedSteps: steps.length,
      actual,
      expected: [actual],
      trace: getTrace(),
    };
  } finally {
    await driver.dispose?.();
  }
};

export const checkTrace = async <Action, Observation>(
  trace: Trace<Action, Observation>,
  driver: Driver<Action, Observation>,
  comparison: Comparison<Observation> = {},
): Promise<ConformanceResult<Action, Observation>> => {
  const equal = comparison.equal ?? equalValues;
  try {
    const initial = await driver.reset();
    const actualTrace: Trace<Action, Observation> = {
      ...trace,
      initial,
      steps: [],
    };
    const steps: { action: Action; observation: Observation }[] = [];
    const getTrace = (): Trace<Action, Observation> => ({
      ...actualTrace,
      steps: [...steps],
    });
    if (!equal(trace.initial, initial)) {
      return {
        status: "mismatch",
        checkedSteps: 0,
        actual: initial,
        expected: [trace.initial],
        trace: actualTrace,
      };
    }
    let actual = initial;
    for (const step of trace.steps) {
      actual = await driver.step(step.action);
      steps.push({ action: step.action, observation: actual });
      if (!equal(step.observation, actual)) {
        return {
          status: "mismatch",
          checkedSteps: steps.length,
          actual,
          expected: [step.observation],
          trace: getTrace(),
        };
      }
    }
    return {
      status: "matched",
      checkedSteps: trace.steps.length,
      actual,
      expected: [actual],
      trace: getTrace(),
    };
  } finally {
    await driver.dispose?.();
  }
};

export const checkDifferential = async <Action, Observation>(
  reference: Driver<Action, Observation>,
  candidate: Driver<Action, Observation>,
  actions: readonly Action[],
  comparison: Comparison<Observation> = {},
): Promise<ConformanceResult<Action, Observation>> => {
  const trace: Trace<Action, Observation> = await (async () => {
    try {
      const initial = await reference.reset();
      const steps: { action: Action; observation: Observation }[] = [];
      for (const action of actions)
        steps.push({ action, observation: await reference.step(action) });
      return { version: 1, model: "differential", initial, steps };
    } finally {
      await reference.dispose?.();
    }
  })();
  return checkTrace(trace, candidate, comparison);
};
