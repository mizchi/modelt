export interface Operation<Input, Output> {
  readonly id: string;
  readonly call: number;
  readonly returned: number;
  readonly input: Input;
  readonly output: Output;
}

export interface HistoryModel<State, Input, Output> {
  readonly initial: State;
  readonly key: (state: State) => string;
  readonly step: (
    state: State,
    input: Input,
    output: Output,
  ) => readonly State[];
}

export interface HistoryResult {
  readonly status:
    | "linearizable"
    | "not-linearizable"
    | "inconclusive"
    | "empty";
  readonly explored: number;
  readonly order: readonly string[];
}

export class HistoryFormatError extends Error {
  override readonly name = "HistoryFormatError";
}

export const checkHistory = <State, Input, Output>(
  model: HistoryModel<State, Input, Output>,
  history: readonly Operation<Input, Output>[],
  maxNodes: number,
): HistoryResult => {
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1)
    throw new RangeError("maxNodes must be a positive integer");
  const ids = new Set<string>();
  const events = new Set<number>();
  for (const operation of history) {
    if (
      ids.has(operation.id) ||
      !Number.isSafeInteger(operation.call) ||
      !Number.isSafeInteger(operation.returned) ||
      operation.call < 0 ||
      operation.call >= operation.returned ||
      events.has(operation.call) ||
      events.has(operation.returned)
    )
      throw new HistoryFormatError("Invalid completed operation history");
    ids.add(operation.id);
    events.add(operation.call);
    events.add(operation.returned);
  }
  if (history.length === 0) return { status: "empty", explored: 0, order: [] };
  const visited = new Set<string>();
  let explored = 0;
  let limited = false;
  const visit = (
    state: State,
    remaining: readonly Operation<Input, Output>[],
    order: readonly string[],
  ): readonly string[] | undefined => {
    if (remaining.length === 0) return order;
    const key = JSON.stringify([
      model.key(state),
      remaining.map((operation) => operation.id),
    ]);
    if (visited.has(key)) return;
    if (explored === maxNodes) {
      limited = true;
      return;
    }
    visited.add(key);
    explored++;
    for (const operation of remaining) {
      if (remaining.some((other) => other.returned < operation.call)) continue;
      for (const successor of model.step(
        state,
        operation.input,
        operation.output,
      )) {
        const result = visit(
          successor,
          remaining.filter((other) => other.id !== operation.id),
          [...order, operation.id],
        );
        if (result) return result;
        if (limited) return;
      }
    }
  };
  const order = visit(model.initial, history, []);
  return {
    status: order
      ? "linearizable"
      : limited
        ? "inconclusive"
        : "not-linearizable",
    explored,
    order: order ?? [],
  };
};

export const incrementHistoryModel: HistoryModel<number, number, number> = {
  initial: 0,
  key: String,
  step: (state, input, output) => (output === state + input ? [output] : []),
};
