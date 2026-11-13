export interface Transition<State, Observation> {
  readonly state: State;
  readonly observation: Observation;
}

export interface Model<State, Action, Observation> {
  readonly name: string;
  readonly initial: () => readonly Transition<State, Observation>[];
  readonly actions: (state: State) => readonly Action[];
  readonly step: (
    state: State,
    action: Action,
  ) => readonly Transition<State, Observation>[];
  readonly key: (state: State) => string;
  readonly invariants?: readonly {
    readonly name: string;
    readonly check: (state: State) => boolean;
  }[];
}

export interface Driver<Action, Observation> {
  readonly reset: () => Observation | Promise<Observation>;
  readonly step: (action: Action) => Observation | Promise<Observation>;
  readonly dispose?: () => void | Promise<void>;
}

export interface Trace<Action, Observation> {
  readonly version: 1;
  readonly model: string;
  readonly initial: Observation;
  readonly steps: readonly {
    readonly action: Action;
    readonly observation: Observation;
  }[];
}

export interface ConformanceResult<Action, Observation> {
  readonly status: "matched" | "mismatch" | "invalid";
  readonly checkedSteps: number;
  readonly actual: Observation;
  readonly expected: readonly Observation[];
  readonly trace: Trace<Action, Observation>;
}

export interface Comparison<Observation> {
  readonly equal?: (expected: Observation, actual: Observation) => boolean;
}
