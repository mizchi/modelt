import {
  type CounterAction,
  counterModel,
} from "../../examples/counter-model.js";

export interface CounterTable {
  readonly offsets: Uint32Array;
  readonly actions: Uint32Array;
  readonly targets: Uint32Array;
  readonly catalog: readonly CounterAction[];
  readonly actionIds: ReadonlyMap<string, number>;
  readonly stateIds: ReadonlyMap<string, number>;
}

export interface KernelOptions {
  readonly seed: number;
  readonly operations: number;
  readonly depth: number;
  readonly strategy: number;
  readonly repeats: number;
  readonly trace: boolean;
}

export interface KernelResult {
  readonly cases: number;
  readonly operations: number;
  readonly steps: number;
  readonly checksum: number;
  readonly trace: readonly number[];
}

export const compileCounterTable = (): CounterTable => {
  const initial = counterModel.initial()[0];
  if (!initial) throw new Error("No initial state");
  const states = [initial.state];
  const stateIds = new Map([[counterModel.key(initial.state), 0]]);
  const actionIds = new Map<string, number>();
  const catalog: CounterAction[] = [];
  const offsets = [0];
  const actions: number[] = [];
  const targets: number[] = [];
  for (const state of states) {
    for (const action of counterModel.actions(state)) {
      const successor = counterModel.step(state, action)[0];
      if (!successor) throw new Error("Disabled action in table compilation");
      const key = counterModel.key(successor.state);
      if (!stateIds.has(key)) {
        stateIds.set(key, states.length);
        states.push(successor.state);
      }
      const actionKey = JSON.stringify(action);
      if (!actionIds.has(actionKey)) {
        actionIds.set(actionKey, catalog.length);
        catalog.push(action);
      }
      const actionId = actionIds.get(actionKey);
      const target = stateIds.get(key);
      if (actionId === undefined || target === undefined)
        throw new Error("Missing compiled transition");
      actions.push(actionId);
      targets.push(target);
    }
    offsets.push(actions.length);
  }
  return {
    offsets: Uint32Array.from(offsets),
    actions: Uint32Array.from(actions),
    targets: Uint32Array.from(targets),
    catalog,
    actionIds,
    stateIds,
  };
};

export const validateKernelOptions = (options: KernelOptions): void => {
  if (
    !Number.isInteger(options.seed) ||
    options.seed < 0 ||
    options.seed > 0xffff_ffff ||
    !Number.isInteger(options.operations) ||
    options.operations < 2 ||
    options.operations > 0xffff_ffff ||
    !Number.isInteger(options.depth) ||
    options.depth < 1 ||
    options.depth > 0xffff_ffff ||
    !Number.isInteger(options.repeats) ||
    options.repeats < 1 ||
    options.repeats * options.operations > 0xffff_ffff ||
    (options.strategy !== 0 && options.strategy !== 1)
  )
    throw new RangeError("Invalid kernel options");
};

export const runTable = (
  table: CounterTable,
  options: KernelOptions,
): KernelResult => {
  validateKernelOptions(options);
  let checksum = 2166136261;
  let totalCases = 0;
  let totalOperations = 0;
  let steps = 0;
  const trace: number[] = [];
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    let random = (options.seed + repeat) >>> 0 || 0x9e3779b9;
    let operations = 0;
    let cases = 0;
    while (options.operations - operations >= 2) {
      const depth = Math.min(
        options.strategy === 1 && cases % 2 === 0
          ? Math.max(1, Math.floor(options.depth / 2))
          : options.depth,
        options.operations - operations - 1,
      );
      if (options.trace) trace.push(depth);
      checksum = (Math.imul(checksum, 16777619) ^ 0xffff_fffe) >>> 0;
      let state = 0;
      for (let index = 0; index < depth; index++) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        const start = table.offsets[state] ?? 0;
        const end = table.offsets[state + 1] ?? 0;
        const edge =
          start + Math.floor(((random >>> 0) / 0x1_0000_0000) * (end - start));
        const action = table.actions[edge];
        const target = table.targets[edge];
        if (action === undefined || target === undefined)
          throw new Error("Invalid packed state");
        checksum =
          (Math.imul(Math.imul(checksum, 16777619) ^ action, 16777619) ^
            target) >>>
          0;
        if (options.trace) trace.push(action);
        state = target;
        steps++;
      }
      operations += depth + 1;
      cases++;
    }
    totalCases += cases;
    totalOperations += operations;
  }
  return {
    cases: totalCases,
    operations: totalOperations,
    steps,
    checksum,
    trace,
  };
};

export const runDynamic = (
  table: CounterTable,
  options: KernelOptions,
): KernelResult => {
  validateKernelOptions(options);
  let checksum = 2166136261;
  let totalCases = 0;
  let totalOperations = 0;
  let steps = 0;
  const trace: number[] = [];
  for (let repeat = 0; repeat < options.repeats; repeat++) {
    let random = (options.seed + repeat) >>> 0 || 0x9e3779b9;
    let operations = 0;
    let cases = 0;
    while (options.operations - operations >= 2) {
      const depth = Math.min(
        options.strategy === 1 && cases % 2 === 0
          ? Math.max(1, Math.floor(options.depth / 2))
          : options.depth,
        options.operations - operations - 1,
      );
      const initial = counterModel.initial()[0];
      if (!initial) throw new Error("Missing initial state");
      let state = initial.state;
      if (options.trace) trace.push(depth);
      checksum = (Math.imul(checksum, 16777619) ^ 0xffff_fffe) >>> 0;
      for (let index = 0; index < depth; index++) {
        random ^= random << 13;
        random ^= random >>> 17;
        random ^= random << 5;
        const enabled = counterModel.actions(state);
        const action =
          enabled[
            Math.floor(((random >>> 0) / 0x1_0000_0000) * enabled.length)
          ];
        if (!action) throw new Error("Missing action");
        const successor = counterModel.step(state, action)[0];
        if (!successor) throw new Error("Missing successor");
        const actionId = table.actionIds.get(JSON.stringify(action));
        const target = table.stateIds.get(counterModel.key(successor.state));
        if (actionId === undefined || target === undefined)
          throw new Error("State absent from compiled table");
        checksum =
          (Math.imul(Math.imul(checksum, 16777619) ^ actionId, 16777619) ^
            target) >>>
          0;
        if (options.trace) trace.push(actionId);
        state = successor.state;
        steps++;
      }
      operations += depth + 1;
      cases++;
    }
    totalCases += cases;
    totalOperations += operations;
  }
  return {
    cases: totalCases,
    operations: totalOperations,
    steps,
    checksum,
    trace,
  };
};

export const decodeCases = (
  table: CounterTable,
  trace: readonly number[],
): readonly (readonly CounterAction[])[] => {
  const cases: CounterAction[][] = [];
  for (let offset = 0; offset < trace.length; ) {
    const length = trace[offset++];
    if (length === undefined || length < 1 || offset + length > trace.length)
      throw new Error("Malformed kernel trace");
    cases.push(
      trace.slice(offset, offset + length).map((id) => {
        const action = table.catalog[id];
        if (!action) throw new Error("Unknown action ID");
        return action;
      }),
    );
    offset += length;
  }
  return cases;
};
