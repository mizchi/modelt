import type { Model, Transition } from "./contracts.js";

export interface ProductState<
  LeftState,
  LeftObservation,
  RightState,
  RightObservation,
> {
  readonly left: Transition<LeftState, LeftObservation>;
  readonly right: Transition<RightState, RightObservation>;
}

export type ProductAction<LeftAction, RightAction> =
  | { readonly target: "left"; readonly action: LeftAction }
  | { readonly target: "right"; readonly action: RightAction }
  | {
      readonly target: "both";
      readonly left: LeftAction;
      readonly right: RightAction;
    };

export interface ProductObservation<LeftObservation, RightObservation> {
  readonly left: LeftObservation;
  readonly right: RightObservation;
}

export interface CompositionOptions<
  LeftState,
  LeftAction,
  LeftObservation,
  RightState,
  RightAction,
  RightObservation,
> {
  readonly name: string;
  readonly sharedActions?: (
    state: ProductState<
      LeftState,
      LeftObservation,
      RightState,
      RightObservation
    >,
  ) => readonly { readonly left: LeftAction; readonly right: RightAction }[];
  readonly invariants?: readonly {
    readonly name: string;
    readonly check: (
      state: ProductState<
        LeftState,
        LeftObservation,
        RightState,
        RightObservation
      >,
    ) => boolean;
  }[];
}

export const composeModels = <
  LeftState,
  LeftAction,
  LeftObservation,
  RightState,
  RightAction,
  RightObservation,
>(
  left: Model<LeftState, LeftAction, LeftObservation>,
  right: Model<RightState, RightAction, RightObservation>,
  options: CompositionOptions<
    LeftState,
    LeftAction,
    LeftObservation,
    RightState,
    RightAction,
    RightObservation
  >,
): Model<
  ProductState<LeftState, LeftObservation, RightState, RightObservation>,
  ProductAction<LeftAction, RightAction>,
  ProductObservation<LeftObservation, RightObservation>
> => {
  const transition = (
    leftEntry: Transition<LeftState, LeftObservation>,
    rightEntry: Transition<RightState, RightObservation>,
  ) => ({
    state: { left: leftEntry, right: rightEntry },
    observation: { left: leftEntry.observation, right: rightEntry.observation },
  });
  return {
    name: options.name,
    initial: () =>
      left
        .initial()
        .flatMap((leftEntry) =>
          right
            .initial()
            .map((rightEntry) => transition(leftEntry, rightEntry)),
        ),
    key: (state) =>
      JSON.stringify([
        left.key(state.left.state),
        right.key(state.right.state),
      ]),
    actions: (state) => [
      ...left.actions(state.left.state).map(
        (action): ProductAction<LeftAction, RightAction> => ({
          target: "left",
          action,
        }),
      ),
      ...right.actions(state.right.state).map(
        (action): ProductAction<LeftAction, RightAction> => ({
          target: "right",
          action,
        }),
      ),
      ...(options.sharedActions?.(state) ?? []).map(
        (action): ProductAction<LeftAction, RightAction> => ({
          target: "both",
          left: action.left,
          right: action.right,
        }),
      ),
    ],
    step: (state, action) => {
      if (action.target === "left")
        return left
          .step(state.left.state, action.action)
          .map((entry) => transition(entry, state.right));
      if (action.target === "right")
        return right
          .step(state.right.state, action.action)
          .map((entry) => transition(state.left, entry));
      return left
        .step(state.left.state, action.left)
        .flatMap((leftEntry) =>
          right
            .step(state.right.state, action.right)
            .map((rightEntry) => transition(leftEntry, rightEntry)),
        );
    },
    invariants: [
      ...(left.invariants ?? []).map((property) => ({
        name: `${left.name}/${property.name}`,
        check: (
          state: ProductState<
            LeftState,
            LeftObservation,
            RightState,
            RightObservation
          >,
        ) => property.check(state.left.state),
      })),
      ...(right.invariants ?? []).map((property) => ({
        name: `${right.name}/${property.name}`,
        check: (
          state: ProductState<
            LeftState,
            LeftObservation,
            RightState,
            RightObservation
          >,
        ) => property.check(state.right.state),
      })),
      ...(options.invariants ?? []),
    ],
  };
};
