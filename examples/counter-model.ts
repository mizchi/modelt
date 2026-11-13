import type { Model, Transition } from "../src/index.js";

export interface Request {
  readonly id: string;
  readonly amount: number;
}

export type CounterAction =
  | ({ readonly type: "add" | "send" } & Request)
  | { readonly type: "deliver" | "drop"; readonly index: number }
  | { readonly type: "crash" | "restart" };

export interface CounterObservation {
  readonly running: boolean;
  readonly value: number;
}

export interface CounterState {
  readonly running: boolean;
  readonly committed: readonly Request[];
  readonly pending: readonly Request[];
}

const transition = (
  state: CounterState,
): Transition<CounterState, CounterObservation> => ({
  state,
  observation: {
    running: state.running,
    value: state.running
      ? state.committed.reduce((total, request) => total + request.amount, 0)
      : 0,
  },
});

export const counterModel: Model<
  CounterState,
  CounterAction,
  CounterObservation
> = {
  name: "durable-counter",
  initial: () => [transition({ running: true, committed: [], pending: [] })],
  key: (state) =>
    JSON.stringify([
      state.running,
      [...state.committed].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
      state.pending,
    ]),
  actions: (state) => [
    { type: "crash" },
    { type: "restart" },
    ...["a", "b"].flatMap((id): CounterAction[] => [
      { type: "add", id, amount: 1 },
      ...(state.pending.length < 2
        ? [{ type: "send" as const, id, amount: 1 }]
        : []),
    ]),
    ...state.pending.flatMap((_, index): CounterAction[] => [
      { type: "deliver", index },
      { type: "drop", index },
    ]),
  ],
  step: (state, action) => {
    if (action.type === "crash")
      return [transition({ ...state, running: false })];
    if (action.type === "restart")
      return [transition({ ...state, running: true })];
    if (action.type === "send") {
      return state.pending.length === 2
        ? []
        : [
            transition({
              ...state,
              pending: [
                ...state.pending,
                { id: action.id, amount: action.amount },
              ],
            }),
          ];
    }
    if (action.type === "deliver" || action.type === "drop") {
      const request = state.pending[action.index];
      if (!Number.isInteger(action.index) || !request) return [];
      const remaining = state.pending.filter(
        (_, index) => index !== action.index,
      );
      const committed =
        action.type === "deliver" &&
        state.running &&
        !state.committed.some((entry) => entry.id === request.id)
          ? [...state.committed, request]
          : state.committed;
      return [transition({ ...state, pending: remaining, committed })];
    }
    if (action.type === "add") {
      return [
        transition({
          ...state,
          committed:
            state.running &&
            !state.committed.some((entry) => entry.id === action.id)
              ? [...state.committed, { id: action.id, amount: action.amount }]
              : state.committed,
        }),
      ];
    }
    return [];
  },
  invariants: [
    {
      name: "unique-request-ids",
      check: (state) =>
        new Set(state.committed.map((entry) => entry.id)).size ===
        state.committed.length,
    },
  ],
};
