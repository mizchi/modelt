import type { ExplorationBounds } from "./checker.js";
import { checkConformance } from "./conformance.js";
import type {
  FiniteModel,
  Model,
  PortableEncoding,
  PortableResult,
  PortableTrace,
  PortableValue,
} from "./contracts.js";
import {
  normalizePortableValue,
  PortableCoreError,
  parsePortableTrace,
  toPortableValue,
} from "./portable-value.js";
import { isRecord } from "./trace.js";

export type { FiniteModel } from "./contracts.js";

export interface FiniteCompilation {
  readonly status: "complete" | "bounded" | "empty";
  readonly model?: FiniteModel;
  readonly states: number;
  readonly edges: number;
}

export const compileFiniteModel = <State, Action, Observation>(
  model: Model<State, Action, Observation>,
  bounds: ExplorationBounds,
  encoding: PortableEncoding<State, Action, Observation> = {},
): FiniteCompilation => {
  if (
    !Number.isSafeInteger(bounds.maxDepth) ||
    bounds.maxDepth < 0 ||
    !Number.isSafeInteger(bounds.maxStates) ||
    bounds.maxStates < 1
  )
    throw new RangeError("Invalid finite model bounds");
  const queue: { state: State; depth: number; key: string }[] = [];
  const visited = new Set<string>();
  let bounded = false;
  let edges = 0;
  const accept = (state: State, depth: number): string => {
    const key = model.key(state);
    if (visited.has(key)) return key;
    if (depth > bounds.maxDepth || visited.size === bounds.maxStates) {
      bounded = true;
      return key;
    }
    visited.add(key);
    queue.push({ state, depth, key });
    return key;
  };
  const initial = model.initial().map((entry) => ({
    key: accept(entry.state, 0),
    observation: normalizePortableValue(
      (encoding.observation ?? toPortableValue)(entry.observation),
    ),
  }));
  const states: FiniteModel["states"][number][] = [];
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index];
    if (!entry) continue;
    const actions = new Map(
      model
        .actions(entry.state)
        .map((action) => [
          JSON.stringify(
            normalizePortableValue(
              (encoding.action ?? toPortableValue)(action),
            ),
          ),
          action,
        ]),
    );
    const transitions = [...actions.values()].flatMap((action) =>
      model.step(entry.state, action).map((successor) => {
        edges++;
        return {
          action: normalizePortableValue(
            (encoding.action ?? toPortableValue)(action),
          ),
          target: accept(successor.state, entry.depth + 1),
          observation: normalizePortableValue(
            (encoding.observation ?? toPortableValue)(successor.observation),
          ),
        };
      }),
    );
    states.push({
      key: entry.key,
      violations: (model.invariants ?? [])
        .filter((property) => !property.check(entry.state))
        .map((property) => property.name),
      transitions,
    });
  }
  if (bounded) return { status: "bounded", states: visited.size, edges };
  if (initial.length === 0) return { status: "empty", states: 0, edges: 0 };
  return {
    status: "complete",
    states: states.length,
    edges,
    model: parseFiniteModel({
      format: "modelt.finite-model",
      version: 1,
      name: model.name,
      initial,
      states,
    }),
  };
};

const object = (
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new PortableCoreError("protocol", "Invalid finite model fields");
  return value;
};
const text = (value: unknown): string => {
  if (typeof value !== "string")
    throw new PortableCoreError("protocol", "Invalid finite model string");
  normalizePortableValue({ type: "string", value });
  return value;
};
export const parseFiniteModel = (value: unknown): FiniteModel => {
  const source = object(value, [
    "format",
    "version",
    "name",
    "initial",
    "states",
  ]);
  if (
    source.format !== "modelt.finite-model" ||
    source.version !== 1 ||
    !Array.isArray(source.initial) ||
    !Array.isArray(source.states)
  )
    throw new PortableCoreError("protocol", "Unsupported finite model");
  const states = source.states.map((state: unknown) => {
    const entry = object(state, ["key", "violations", "transitions"]);
    if (!Array.isArray(entry.violations) || !Array.isArray(entry.transitions))
      throw new PortableCoreError("protocol", "Invalid finite state");
    return {
      key: text(entry.key),
      violations: entry.violations.map((name: unknown) => text(name)),
      transitions: entry.transitions.map((transition: unknown) => {
        const edge = object(transition, ["action", "target", "observation"]);
        return {
          action: normalizePortableValue(edge.action),
          target: text(edge.target),
          observation: normalizePortableValue(edge.observation),
        };
      }),
    };
  });
  const keys = new Set(states.map((state) => state.key));
  if (
    keys.size !== states.length ||
    states.some((state) =>
      state.transitions.some((edge) => !keys.has(edge.target)),
    )
  )
    throw new PortableCoreError(
      "protocol",
      "Duplicate state or missing target",
    );
  const initial = source.initial.map((value: unknown) => {
    const entry = object(value, ["key", "observation"]);
    const key = text(entry.key);
    if (!keys.has(key))
      throw new PortableCoreError("protocol", "Missing initial state");
    return { key, observation: normalizePortableValue(entry.observation) };
  });
  return {
    format: "modelt.finite-model",
    version: 1,
    name: text(source.name),
    initial,
    states,
  };
};

export const createFiniteModel = (
  artifact: FiniteModel,
): Model<string, PortableValue, PortableValue> => {
  const model = parseFiniteModel(artifact);
  const states = new Map(model.states.map((state) => [state.key, state]));
  const violations = [
    ...new Set(model.states.flatMap((state) => state.violations)),
  ];
  return {
    name: model.name,
    initial: () =>
      model.initial.map((entry) => ({
        state: entry.key,
        observation: entry.observation,
      })),
    key: (state) => state,
    actions: (state) => [
      ...new Map(
        (states.get(state)?.transitions ?? []).map((edge) => [
          JSON.stringify(edge.action),
          edge.action,
        ]),
      ).values(),
    ],
    step: (state, action) =>
      (states.get(state)?.transitions ?? [])
        .filter(
          (edge) =>
            JSON.stringify(edge.action) ===
            JSON.stringify(normalizePortableValue(action)),
        )
        .map((edge) => ({ state: edge.target, observation: edge.observation })),
    invariants: violations.map((name) => ({
      name,
      check: (state) => !(states.get(state)?.violations.includes(name) ?? true),
    })),
  };
};

export const checkFiniteHistory = async (
  model: Model<string, PortableValue, PortableValue>,
  trace: PortableTrace,
): Promise<PortableResult> => {
  const history = parsePortableTrace(trace);
  if (history.model !== model.name)
    throw new PortableCoreError(
      "protocol",
      "Finite history model or format differs",
    );
  let index = 0;
  const result = await checkConformance(
    model,
    {
      reset: () => history.initial,
      step: () => {
        const step = history.steps[index++];
        if (!step)
          throw new PortableCoreError("protocol", "Missing history step");
        return step.observation;
      },
    },
    history.steps.map((step) => step.action),
  );
  return {
    ...result,
    trace: { ...result.trace, format: "modelt.portable-trace" },
  };
};
