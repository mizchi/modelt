import type {
  ConcurrentHistory,
  ConcurrentResult,
  FiniteModel,
  HistoryEvent,
  HistoryRecorder,
  PortableValue,
} from "./contracts.js";
import { createFiniteModel } from "./finite.js";
import { normalizePortableValue, PortableCoreError } from "./portable-value.js";
import { isRecord } from "./trace.js";

interface Frame {
  readonly state: string;
  readonly remaining: readonly number[];
  readonly order: readonly string[];
}

interface Operation {
  readonly id: string;
  readonly call: number;
  readonly action: PortableValue;
  returned?: number;
  observation?: PortableValue;
  outcome?: string;
}

const text = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0)
    throw new PortableCoreError("protocol", "Invalid history id or model name");
  normalizePortableValue({ type: "string", value });
  return value;
};

const parseEvent = (event: unknown): HistoryEvent => {
  if (!isRecord(event))
    throw new PortableCoreError("protocol", "Invalid history event");
  const id = text(event.id);
  if (
    event.kind === "invoke" &&
    Object.keys(event).sort().join() === "action,id,kind"
  )
    return {
      kind: "invoke",
      id,
      action: normalizePortableValue(event.action),
    };
  if (
    event.kind === "return" &&
    Object.keys(event).sort().join() === "id,kind,observation"
  )
    return {
      kind: "return",
      id,
      observation: normalizePortableValue(event.observation),
    };
  if (
    (event.kind === "fail" ||
      event.kind === "unknown" ||
      event.kind === "cancel") &&
    Object.keys(event).sort().join() === "id,kind"
  )
    return { kind: event.kind, id };
  throw new PortableCoreError("protocol", "Invalid history event fields");
};

export const parseConcurrentHistory = (input: unknown): ConcurrentHistory => {
  if (
    !isRecord(input) ||
    input.format !== "modelt.concurrent-history" ||
    input.version !== 1 ||
    !Array.isArray(input.events) ||
    Object.keys(input).sort().join() !== "events,format,initial,model,version"
  )
    throw new PortableCoreError("protocol", "Unsupported concurrent history");
  const events = input.events.map(parseEvent);
  const history: ConcurrentHistory = {
    format: "modelt.concurrent-history",
    version: 1,
    model: text(input.model),
    initial: normalizePortableValue(input.initial),
    events,
  };
  operations(history);
  return history;
};

const applyEvent = (
  entries: Map<string, Operation>,
  index: number,
  event: HistoryEvent,
): void => {
  if (event.kind === "invoke") {
    if (entries.has(event.id))
      throw new PortableCoreError("protocol", "Duplicate history id");
    entries.set(event.id, {
      id: event.id,
      call: index,
      action: event.action,
    });
    return;
  }
  const entry = entries.get(event.id);
  if (
    !entry ||
    entry.outcome === "return" ||
    entry.outcome === "fail" ||
    (entry.outcome !== undefined &&
      event.kind !== "return" &&
      event.kind !== "fail")
  )
    throw new PortableCoreError(
      "protocol",
      "Missing or already completed history id",
    );
  entry.outcome = event.kind;
  if (event.kind === "return") {
    entry.returned = index;
    entry.observation = event.observation;
  }
};

const operations = (history: ConcurrentHistory): readonly Operation[] => {
  const entries = new Map<string, Operation>();
  for (const [index, event] of history.events.entries())
    applyEvent(entries, index, event);
  return [...entries.values()].filter((entry) => entry.outcome !== "fail");
};

export const createHistoryRecorder = (
  model: string,
  initial: PortableValue,
): HistoryRecorder => {
  const history = parseConcurrentHistory({
    format: "modelt.concurrent-history",
    version: 1,
    model,
    initial,
    events: [],
  });
  const events: HistoryEvent[] = [];
  const entries = new Map<string, Operation>();
  const append = (event: HistoryEvent) => {
    const normalized = parseEvent(event);
    applyEvent(entries, events.length, normalized);
    events.push(normalized);
  };
  return {
    invoke: (id, action) => append({ kind: "invoke", id, action }),
    returned: (id, observation) => append({ kind: "return", id, observation }),
    end: (id, kind) => append({ kind, id }),
    snapshot: () => parseConcurrentHistory({ ...history, events }),
  };
};

export const checkConcurrentHistory = (
  artifact: FiniteModel,
  input: ConcurrentHistory,
  maxNodes: number,
): ConcurrentResult => {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 0xffff_ffff)
    throw new PortableCoreError("protocol", "Invalid history node budget");
  const history = parseConcurrentHistory(input);
  const model = createFiniteModel(artifact);
  if (model.initial().length === 0)
    throw new PortableCoreError(
      "protocol",
      "Concurrent model has no initial states",
    );
  if (history.model !== model.name)
    throw new PortableCoreError("protocol", "History model differs");
  const entries = operations(history);
  const pending = entries
    .filter((entry) => entry.returned === undefined)
    .map((entry) => entry.id);
  const base: Omit<ConcurrentResult, "status"> = {
    explored: 0,
    order: [],
    omitted: [],
    pending,
  };
  if (history.events.length === 0) return { ...base, status: "empty" };
  const stack: Frame[] = model
    .initial()
    .filter(
      (entry) =>
        JSON.stringify(entry.observation) === JSON.stringify(history.initial),
    )
    .reverse()
    .map((entry) => ({
      state: entry.state,
      remaining: entries.map((_, index) => index),
      order: [],
    }));
  const visited = new Set<string>();
  let explored = 0;
  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const remaining = frame.remaining
      .map((index) => entries[index])
      .filter((entry) => entry !== undefined);
    if (remaining.every((entry) => entry.returned === undefined))
      return {
        status: "linearizable",
        explored,
        order: frame.order,
        omitted: remaining.map((entry) => entry.id),
        pending,
      };
    const key = JSON.stringify([frame.state, frame.remaining]);
    if (visited.has(key)) continue;
    if (explored === maxNodes)
      return { ...base, status: "inconclusive", explored };
    visited.add(key);
    explored++;
    const children = remaining.flatMap((operation) => {
      if (
        remaining.some(
          (other) =>
            other.returned !== undefined && other.returned < operation.call,
        )
      )
        return [];
      return model
        .step(frame.state, operation.action)
        .filter(
          (edge) =>
            operation.observation === undefined ||
            JSON.stringify(edge.observation) ===
              JSON.stringify(operation.observation),
        )
        .map((edge) => ({
          state: edge.state,
          remaining: frame.remaining.filter(
            (index) => entries[index]?.id !== operation.id,
          ),
          order: [...frame.order, operation.id],
        }));
    });
    for (const child of children.reverse()) stack.push(child);
  }
  return { ...base, status: "not-linearizable", explored };
};

export type {
  ConcurrentHistory,
  ConcurrentResult,
  HistoryEvent,
  HistoryRecorder,
} from "./contracts.js";
