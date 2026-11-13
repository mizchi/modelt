import type {
  DeletionRange,
  Driver,
  FiniteModel,
  HostTape,
  Model,
  PortableCommand,
  PortableCore,
  PortableEffect,
  PortableEncoding,
  PortableOutput,
  PortableResponse,
  PortableResult,
  PortableTrace,
  PortableValue,
  Trace,
} from "./contracts.js";
import {
  normalizePortableValue,
  PortableCoreError,
  parsePortableTrace,
  toPortableValue,
} from "./portable-value.js";
import { isRecord } from "./trace.js";

const fields = (
  value: unknown,
  names: readonly string[],
): Record<string, unknown> => {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    throw new PortableCoreError("protocol", "Invalid core message fields");
  return value;
};
const requestId = (value: unknown): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 0xffff_ffff
  )
    throw new PortableCoreError("protocol", "Invalid effect ID");
  return value;
};
const parseEffect = (value: unknown): PortableEffect => {
  if (!isRecord(value))
    throw new PortableCoreError("protocol", "Invalid effect");
  switch (value.kind) {
    case "model-initial":
    case "driver-reset":
      fields(value, ["kind", "id"]);
      return { kind: value.kind, id: requestId(value.id) };
    case "model-step": {
      fields(value, ["kind", "id", "states", "action"]);
      if (!Array.isArray(value.states))
        throw new PortableCoreError("protocol", "Invalid states");
      return {
        kind: "model-step",
        id: requestId(value.id),
        action: normalizePortableValue(value.action),
        states: value.states.map((state: unknown) => {
          const entry = fields(state, ["key", "state"]);
          if (typeof entry.key !== "string")
            throw new PortableCoreError("protocol", "Invalid state key");
          return { key: entry.key, state: normalizePortableValue(entry.state) };
        }),
      };
    }
    case "driver-step":
      fields(value, ["kind", "id", "action"]);
      return {
        kind: "driver-step",
        id: requestId(value.id),
        action: normalizePortableValue(value.action),
      };
    case "done": {
      fields(value, ["kind", "result"]);
      const result = fields(value.result, [
        "status",
        "checkedSteps",
        "actual",
        "expected",
        "trace",
      ]);
      if (
        (result.status !== "matched" &&
          result.status !== "mismatch" &&
          result.status !== "invalid") ||
        typeof result.checkedSteps !== "number" ||
        !Number.isSafeInteger(result.checkedSteps) ||
        result.checkedSteps < 0 ||
        !Array.isArray(result.expected)
      )
        throw new PortableCoreError("protocol", "Invalid conformance result");
      return {
        kind: "done",
        result: {
          status: result.status,
          checkedSteps: result.checkedSteps,
          actual: normalizePortableValue(result.actual),
          expected: result.expected.map((entry: unknown) =>
            normalizePortableValue(entry),
          ),
          trace: parsePortableTrace(result.trace),
        },
      };
    }
  }
  throw new PortableCoreError("protocol", "Unknown effect kind");
};

export const decodePortableResult = (value: unknown): PortableResult => {
  const parsed = parseEffect({ kind: "done", result: value });
  if (parsed.kind !== "done")
    throw new PortableCoreError("protocol", "Invalid finite result");
  return parsed.result;
};

export const createPortableWasm = async (
  bytes: Uint8Array,
): Promise<PortableCore> => {
  const module = await WebAssembly.compile(Uint8Array.from(bytes));
  if (WebAssembly.Module.imports(module).length !== 0)
    throw new PortableCoreError(
      "protocol",
      "Portable core must not require host imports",
    );
  const instance = await WebAssembly.instantiate(module);
  const exports = instance.exports;
  const call = (name: string, ...args: number[]): unknown => {
    const method = exports[`modelt_${name}`];
    if (typeof method !== "function")
      throw new PortableCoreError(
        "protocol",
        `Missing core ABI export: ${name}`,
      );
    return method(...args);
  };
  const unsigned = (name: string, ...args: number[]): number => {
    const result = call(name, ...args);
    if (typeof result !== "number" || !Number.isInteger(result))
      throw new PortableCoreError("protocol", `Invalid ABI result: ${name}`);
    return result >>> 0;
  };
  if (
    unsigned("abi_version") !== 1 ||
    !(exports.memory instanceof WebAssembly.Memory)
  )
    throw new PortableCoreError("protocol", "Unsupported core ABI");
  const memory = exports.memory;
  return {
    request: (command) => {
      const input = new TextEncoder().encode(JSON.stringify(command));
      const pointer = unsigned("input_resize", input.length);
      new Uint8Array(memory.buffer, pointer, input.length).set(input);
      call("dispatch");
      const output: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          new Uint8Array(
            memory.buffer,
            unsigned("output_ptr"),
            unsigned("output_len"),
          ).slice(),
        ),
      );
      if (!isRecord(output))
        throw new PortableCoreError("protocol", "Invalid core response");
      if (output.kind === "error") {
        fields(output, ["kind", "code", "message"]);
        if (
          (output.code !== "value" && output.code !== "protocol") ||
          typeof output.message !== "string"
        )
          throw new PortableCoreError("protocol", "Invalid core error");
        throw new PortableCoreError(output.code, output.message);
      }
      if (output.kind === "cancelled") {
        fields(output, ["kind"]);
        return { kind: "cancelled" };
      }
      if (output.kind === "value") {
        fields(output, ["kind", "value"]);
        return { kind: "value", value: normalizePortableValue(output.value) };
      }
      if (output.kind === "host") {
        fields(output, ["kind", "snapshot"]);
        return {
          kind: "host",
          snapshot: normalizePortableValue(output.snapshot),
        };
      }
      if (output.kind === "results") {
        fields(output, ["kind", "results"]);
        if (!Array.isArray(output.results))
          throw new PortableCoreError("protocol", "Invalid finite results");
        return {
          kind: "results",
          results: output.results.map((result: unknown) =>
            decodePortableResult(result),
          ),
        };
      }
      if (output.kind === "candidates") {
        fields(output, ["kind", "ranges"]);
        if (!Array.isArray(output.ranges))
          throw new PortableCoreError("protocol", "Invalid shrink candidates");
        return {
          kind: "candidates",
          ranges: output.ranges.map((range: unknown) => {
            const parsed = fields(range, ["start", "count"]);
            if (
              typeof parsed.start !== "number" ||
              !Number.isSafeInteger(parsed.start) ||
              parsed.start < 0 ||
              typeof parsed.count !== "number" ||
              !Number.isSafeInteger(parsed.count) ||
              parsed.count < 1
            )
              throw new PortableCoreError("protocol", "Invalid deletion range");
            return { start: parsed.start, count: parsed.count };
          }),
        };
      }
      fields(output, ["kind", "effect"]);
      if (output.kind !== "effect")
        throw new PortableCoreError("protocol", "Unknown core response");
      return { kind: "effect", effect: parseEffect(output.effect) };
    },
  };
};

const runEffects = async (
  core: PortableCore,
  command: () => PortableCommand,
  respond: (
    effect: Exclude<PortableEffect, { kind: "done" }>,
  ) => Promise<PortableResponse>,
  dispose: () => void | Promise<void>,
): Promise<PortableResult> => {
  let pending: PortableEffect | undefined;
  try {
    let output: PortableOutput = core.request(command());
    while (output.kind === "effect") {
      pending = output.effect;
      if (pending.kind === "done") return pending.result;
      const response = await respond(pending);
      output = core.request({
        version: 1,
        request: { kind: "resume", id: pending.id, response },
      });
    }
    throw new PortableCoreError("protocol", "Expected a session effect");
  } finally {
    try {
      if (pending && pending.kind !== "done")
        core.request({
          version: 1,
          request: { kind: "cancel", id: pending.id },
        });
    } finally {
      await dispose();
    }
  }
};

export const checkPortableConformance = async <State, Action, Observation>(
  core: PortableCore,
  model: Model<State, Action, Observation>,
  driver: Driver<Action, Observation>,
  actions: readonly Action[],
  encoding: PortableEncoding<State, Action, Observation> = {},
): Promise<PortableResult> => {
  const encodeState = encoding.state ?? toPortableValue;
  const encodeAction = encoding.action ?? toPortableValue;
  const encodeObservation = encoding.observation ?? toPortableValue;
  const states = new Map<
    string,
    { readonly original: State; readonly key: string }
  >();
  const inputs = new Map<string, { readonly original: Action }>();
  const transitions = (entries: ReturnType<typeof model.initial>) =>
    entries.map((entry) => {
      const state = normalizePortableValue(encodeState(entry.state));
      const key = model.key(entry.state);
      const previous = states.get(JSON.stringify(state));
      if (previous && previous.key !== key)
        throw new PortableCoreError(
          "value",
          "Lossy state encoding merged distinct model keys",
        );
      states.set(JSON.stringify(state), { original: entry.state, key });
      return {
        key,
        state,
        observation: normalizePortableValue(
          encodeObservation(entry.observation),
        ),
      };
    });
  return runEffects(
    core,
    () => ({
      version: 1,
      request: {
        kind: "start",
        model: model.name,
        actions: actions.map((action) => {
          const encoded = normalizePortableValue(encodeAction(action));
          inputs.set(JSON.stringify(encoded), { original: action });
          return encoded;
        }),
      },
    }),
    async (effect) => {
      switch (effect.kind) {
        case "model-initial":
          return {
            kind: "transitions",
            transitions: transitions(model.initial()),
          };
        case "model-step": {
          const input = inputs.get(JSON.stringify(effect.action));
          if (!input)
            throw new PortableCoreError("protocol", "Unknown model action");
          const successors = effect.states.flatMap((entry) => {
            const key = JSON.stringify(entry.state);
            if (!states.has(key))
              throw new PortableCoreError("protocol", "Unknown model state");
            const state = states.get(key);
            if (!state || model.key(state.original) !== entry.key)
              throw new PortableCoreError("protocol", "State key changed");
            return model.step(state.original, input.original);
          });
          return { kind: "transitions", transitions: transitions(successors) };
        }
        case "driver-reset":
          return {
            kind: "observation",
            observation: normalizePortableValue(
              encodeObservation(await driver.reset()),
            ),
          };
        case "driver-step": {
          const input = inputs.get(JSON.stringify(effect.action));
          if (!input)
            throw new PortableCoreError("protocol", "Unknown driver action");
          return {
            kind: "observation",
            observation: normalizePortableValue(
              encodeObservation(await driver.step(input.original)),
            ),
          };
        }
      }
    },
    () => driver.dispose?.(),
  );
};

export const toPortableTrace = <Action, Observation>(
  trace: Trace<Action, Observation>,
  encoding: Pick<
    PortableEncoding<never, Action, Observation>,
    "action" | "observation"
  > = {},
): PortableTrace =>
  parsePortableTrace({
    format: "modelt.portable-trace",
    version: 1,
    model: trace.model,
    initial: (encoding.observation ?? toPortableValue)(trace.initial),
    steps: trace.steps.map((step) => ({
      action: (encoding.action ?? toPortableValue)(step.action),
      observation: (encoding.observation ?? toPortableValue)(step.observation),
    })),
  });

export const checkPortableTrace = async <Action, Observation>(
  core: PortableCore,
  trace: PortableTrace,
  driver: Driver<Action, Observation>,
  decodeAction: (action: PortableValue) => Action,
  encodeObservation: (
    observation: Observation,
  ) => PortableValue = toPortableValue,
): Promise<PortableResult> =>
  runEffects(
    core,
    () => ({
      version: 1,
      request: { kind: "replay", trace: parsePortableTrace(trace) },
    }),
    async (effect) => {
      if (effect.kind === "driver-reset")
        return {
          kind: "observation",
          observation: normalizePortableValue(
            encodeObservation(await driver.reset()),
          ),
        };
      if (effect.kind === "driver-step")
        return {
          kind: "observation",
          observation: normalizePortableValue(
            encodeObservation(await driver.step(decodeAction(effect.action))),
          ),
        };
      throw new PortableCoreError(
        "protocol",
        "Replay requested a model transition",
      );
    },
    () => driver.dispose?.(),
  );

export const checkFiniteConformance = async (
  core: PortableCore,
  model: FiniteModel,
  driver: Driver<PortableValue, PortableValue>,
  actions: readonly PortableValue[],
): Promise<PortableResult> =>
  runEffects(
    core,
    () => ({ version: 1, request: { kind: "start-finite", model, actions } }),
    async (effect) => {
      if (effect.kind === "driver-reset")
        return {
          kind: "observation",
          observation: normalizePortableValue(await driver.reset()),
        };
      if (effect.kind === "driver-step")
        return {
          kind: "observation",
          observation: normalizePortableValue(await driver.step(effect.action)),
        };
      throw new PortableCoreError(
        "protocol",
        "Finite core requested a model host",
      );
    },
    () => driver.dispose?.(),
  );

export const checkFiniteHistories = (
  core: PortableCore,
  model: FiniteModel,
  traces: readonly PortableTrace[],
): readonly PortableResult[] => {
  const result = core.request({
    version: 1,
    request: { kind: "check-finite", model, traces },
  });
  if (result.kind !== "results")
    throw new PortableCoreError("protocol", "Expected finite results");
  return result.results;
};

export const coreDeletionCandidates = (
  core: PortableCore,
  length: number,
): readonly DeletionRange[] => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    throw new RangeError("Invalid sequence length");
  const result = core.request({
    version: 1,
    request: { kind: "shrink-candidates", length },
  });
  if (result.kind !== "candidates")
    throw new PortableCoreError("protocol", "Expected deletion candidates");
  return result.ranges;
};

export const verifyHostTape = (
  core: PortableCore,
  tape: HostTape,
): PortableValue => {
  const result = core.request({
    version: 1,
    request: { kind: "replay-host", tape },
  });
  if (result.kind !== "host")
    throw new PortableCoreError("protocol", "Expected host snapshot");
  return result.snapshot;
};
