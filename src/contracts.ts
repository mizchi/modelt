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

export type PortableValue =
  | { readonly type: "null" }
  | { readonly type: "bool"; readonly value: boolean }
  | { readonly type: "int" | "string" | "bytes"; readonly value: string }
  | { readonly type: "list" | "set"; readonly value: readonly PortableValue[] }
  | {
      readonly type: "record";
      readonly value: readonly (readonly [string, PortableValue])[];
    }
  | {
      readonly type: "map";
      readonly value: readonly (readonly [PortableValue, PortableValue])[];
    };

export interface PortableTrace {
  readonly format: "modelt.portable-trace";
  readonly version: 1;
  readonly model: string;
  readonly initial: PortableValue;
  readonly steps: readonly {
    readonly action: PortableValue;
    readonly observation: PortableValue;
  }[];
}

export interface PortableResult {
  readonly status: "matched" | "mismatch" | "invalid";
  readonly checkedSteps: number;
  readonly actual: PortableValue;
  readonly expected: readonly PortableValue[];
  readonly trace: PortableTrace;
}

export interface PortableState {
  readonly key: string;
  readonly state: PortableValue;
}

export interface PortableTransition extends PortableState {
  readonly observation: PortableValue;
}

export type PortableResponse =
  | {
      readonly kind: "transitions";
      readonly transitions: readonly PortableTransition[];
    }
  | { readonly kind: "observation"; readonly observation: PortableValue };

export type PortableEffect =
  | { readonly kind: "model-initial" | "driver-reset"; readonly id: number }
  | {
      readonly kind: "model-step";
      readonly id: number;
      readonly states: readonly PortableState[];
      readonly action: PortableValue;
    }
  | {
      readonly kind: "driver-step";
      readonly id: number;
      readonly action: PortableValue;
    }
  | { readonly kind: "done"; readonly result: PortableResult };

export interface PortableCommand {
  readonly version: 1;
  readonly request:
    | { readonly kind: "canonicalize"; readonly value: PortableValue }
    | { readonly kind: "replay-host"; readonly tape: HostTape }
    | {
        readonly kind: "start-finite";
        readonly model: FiniteModel;
        readonly actions: readonly PortableValue[];
      }
    | {
        readonly kind: "check-finite";
        readonly model: FiniteModel;
        readonly traces: readonly PortableTrace[];
      }
    | { readonly kind: "shrink-candidates"; readonly length: number }
    | {
        readonly kind: "start";
        readonly model: string;
        readonly actions: readonly PortableValue[];
      }
    | { readonly kind: "replay"; readonly trace: PortableTrace }
    | { readonly kind: "cancel"; readonly id: number }
    | {
        readonly kind: "resume";
        readonly id: number;
        readonly response: PortableResponse;
      };
}

export type PortableOutput =
  | { readonly kind: "host"; readonly snapshot: PortableValue }
  | { readonly kind: "results"; readonly results: readonly PortableResult[] }
  | { readonly kind: "candidates"; readonly ranges: readonly DeletionRange[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "value"; readonly value: PortableValue }
  | { readonly kind: "effect"; readonly effect: PortableEffect };

export interface PortableCore {
  readonly request: (command: PortableCommand) => PortableOutput;
}

export interface PortableEncoding<State, Action, Observation> {
  readonly state?: (state: State) => PortableValue;
  readonly action?: (action: Action) => PortableValue;
  readonly observation?: (observation: Observation) => PortableValue;
}

export interface FiniteModel {
  readonly format: "modelt.finite-model";
  readonly version: 1;
  readonly name: string;
  readonly initial: readonly {
    readonly key: string;
    readonly observation: PortableValue;
  }[];
  readonly states: readonly {
    readonly key: string;
    readonly violations: readonly string[];
    readonly transitions: readonly {
      readonly action: PortableValue;
      readonly target: string;
      readonly observation: PortableValue;
    }[];
  }[];
}
export interface DeletionRange {
  readonly start: number;
  readonly count: number;
}
export type ShrinkVerdict =
  | { readonly status: "matched" | "invalid" }
  | { readonly status: "mismatch"; readonly signature: string };
export interface ShrinkResult<Action> {
  readonly status: "minimal" | "bounded" | "not-failing";
  readonly actions: readonly Action[];
  readonly checks: number;
}
export interface HostTape {
  readonly format: "modelt.host-tape";
  readonly version: 1;
  readonly events: readonly {
    readonly operation: string;
    readonly input: PortableValue;
    readonly output: PortableValue;
  }[];
}
export interface HostMessage {
  readonly id: number;
  readonly from: string;
  readonly to: string;
  readonly payload: PortableValue;
}
export interface SimulationHost {
  readonly now: () => number;
  readonly advance: (amount: number) => void;
  readonly choose: <Choice>(
    label: string,
    choices: readonly Choice[],
  ) => Choice;
  readonly send: (from: string, to: string, payload: unknown) => number;
  readonly deliver: (index: number) => HostMessage;
  readonly drop: (index: number) => void;
  readonly pending: () => readonly HostMessage[];
  readonly write: (key: string, value: unknown) => void;
  readonly read: (key: string) => unknown;
  readonly persist: () => void;
  readonly crash: () => void;
  readonly restart: () => void;
  readonly trace: () => HostTape;
  readonly finish: () => void;
}
