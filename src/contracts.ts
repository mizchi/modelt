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
    | {
        readonly kind: "check-safety";
        readonly program: SafetyProgram;
        readonly bounds: SafetyBounds;
      }
    | { readonly kind: "load-model"; readonly model: FiniteModel }
    | { readonly kind: "release-model"; readonly handle: number }
    | {
        readonly kind: "start-loaded";
        readonly handle: number;
        readonly actions: readonly PortableValue[];
      }
    | {
        readonly kind: "check-loaded";
        readonly handle: number;
        readonly traces: readonly PortableTrace[];
      }
    | {
        readonly kind: "check-history";
        readonly handle: number;
        readonly history: ConcurrentHistory;
        readonly maxNodes: number;
      }
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
  | { readonly kind: "safety"; readonly result: SafetyResult }
  | { readonly kind: "loaded"; readonly handle: number }
  | { readonly kind: "released" }
  | { readonly kind: "history"; readonly result: ConcurrentResult }
  | { readonly kind: "host"; readonly snapshot: PortableValue }
  | { readonly kind: "results"; readonly results: readonly PortableResult[] }
  | { readonly kind: "candidates"; readonly ranges: readonly DeletionRange[] }
  | { readonly kind: "cancelled" }
  | { readonly kind: "value"; readonly value: PortableValue }
  | { readonly kind: "effect"; readonly effect: PortableEffect };

export interface PortableCore {
  readonly request: (command: PortableCommand) => PortableOutput;
}

export type SafetyScalar =
  | { readonly type: "int"; readonly value: string }
  | { readonly type: "bool"; readonly value: boolean };

export type SafetyExpression =
  | { readonly op: "data"; readonly value: PortableValue }
  | { readonly op: "bound"; readonly slot: number }
  | { readonly op: "old" }
  | {
      readonly op: "set" | "tuple";
      readonly values: readonly SafetyExpression[];
    }
  | {
      readonly op: "record" | "record-set";
      readonly fields: readonly (readonly [string, SafetyExpression])[];
    }
  | {
      readonly op: "at";
      readonly target: SafetyExpression;
      readonly key: SafetyExpression;
    }
  | {
      readonly op: "update";
      readonly target: SafetyExpression;
      readonly updates: readonly {
        readonly path: readonly SafetyExpression[];
        readonly value: SafetyExpression;
      }[];
    }
  | {
      readonly op: "forall" | "exists" | "function" | "filter" | "map-set";
      readonly bounds: readonly SafetyBinding[];
      readonly body: SafetyExpression;
    }
  | {
      readonly op:
        | "sequence-set"
        | "domain"
        | "cardinality"
        | "len"
        | "head"
        | "tail"
        | "powerset"
        | "union";
      readonly argument: SafetyExpression;
    }
  | {
      readonly op:
        | "cup"
        | "cap"
        | "difference"
        | "subset-eq"
        | "append"
        | "concat"
        | "function-set"
        | "function-in"
        | "sequence-in";
      readonly left: SafetyExpression;
      readonly right: SafetyExpression;
    }
  | {
      readonly op: "subseq";
      readonly sequence: SafetyExpression;
      readonly from: SafetyExpression;
      readonly to: SafetyExpression;
    }
  | {
      readonly op: "enabled";
      readonly branches: readonly SafetyBranch[];
      readonly subscript?: SafetyExpression;
    }
  | { readonly op: "literal"; readonly value: SafetyScalar }
  | { readonly op: "read"; readonly slot: number; readonly next: boolean }
  | {
      readonly op: "not" | "neg" | "prime";
      readonly argument: SafetyExpression;
    }
  | {
      readonly op:
        | "add"
        | "sub"
        | "mul"
        | "eq"
        | "ne"
        | "lt"
        | "le"
        | "gt"
        | "ge"
        | "and"
        | "or"
        | "implies";
      readonly left: SafetyExpression;
      readonly right: SafetyExpression;
    }
  | {
      readonly op: "if";
      readonly condition: SafetyExpression;
      readonly consequent: SafetyExpression;
      readonly alternative: SafetyExpression;
    }
  | {
      readonly op: "in";
      readonly value: SafetyExpression;
      readonly domain: SafetyDomain;
    };

export type SafetyDomain =
  | { readonly kind: "value"; readonly value: SafetyExpression }
  | {
      readonly kind: "range";
      readonly lower: SafetyExpression;
      readonly upper: SafetyExpression;
    }
  | { readonly kind: "set"; readonly values: readonly SafetyExpression[] };

export type SafetyStep =
  | {
      readonly kind: "bind";
      readonly slot: number;
      readonly domain: SafetyDomain;
      readonly tupleSize?: number;
    }
  | { readonly kind: "guard"; readonly expression: SafetyExpression }
  | {
      readonly kind: "assign";
      readonly slot: number;
      readonly value: SafetyExpression;
    }
  | {
      readonly kind: "choose";
      readonly slot: number;
      readonly domain: SafetyDomain;
    };

export interface SafetyBranch {
  readonly name: string;
  readonly steps: readonly SafetyStep[];
}

export interface SafetyBinding {
  readonly tupleSize?: number;
  readonly slot: number;
  readonly domain: SafetyDomain;
}

export type TemporalFormula =
  | { readonly kind: "atom"; readonly expression: SafetyExpression }
  | {
      readonly kind: "not" | "always" | "eventually";
      readonly formula: TemporalFormula;
    }
  | {
      readonly kind: "and" | "or";
      readonly left: TemporalFormula;
      readonly right: TemporalFormula;
    };

export interface TemporalProperty {
  readonly name: string;
  readonly formula: TemporalFormula;
}

export interface SafetyPredicate {
  readonly name: string;
  readonly expression: SafetyExpression;
}

export interface SafetyProgram {
  readonly format: "modelt.safety-program";
  readonly version: 1;
  readonly name: string;
  readonly variables: readonly string[];
  readonly initial: readonly SafetyBranch[];
  readonly next: readonly SafetyBranch[];
  readonly invariants: readonly SafetyPredicate[];
  readonly assumptions: readonly SafetyPredicate[];
  readonly checkDeadlock: boolean;
  readonly initialProperties?: readonly SafetyPredicate[];
  readonly actionProperties?: readonly SafetyPredicate[];
  readonly properties?: readonly TemporalProperty[];
  readonly fairness?: readonly TemporalFormula[];
}

export interface SafetyBounds {
  readonly maxDepth: number;
  readonly maxStates: number;
  readonly maxWork: number;
  readonly maxTemporalNodes?: number;
}

export interface SafetyResult {
  readonly status:
    | "complete"
    | "bounded"
    | "empty"
    | "invariant-violation"
    | "property-violation"
    | "liveness-violation"
    | "deadlock"
    | "assumption-violation";
  readonly reason: "depth" | "states" | "work" | "temporal" | null;
  readonly states: number;
  readonly generated: number;
  readonly depth: number;
  readonly work: number;
  readonly violation: {
    readonly name: string;
    readonly trace: readonly {
      readonly action: string | null;
      readonly values: readonly PortableValue[];
    }[];
    readonly loopStart?: number;
    readonly loopAction?: string;
  } | null;
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

export type HistoryEvent =
  | {
      readonly kind: "invoke";
      readonly id: string;
      readonly action: PortableValue;
    }
  | {
      readonly kind: "return";
      readonly id: string;
      readonly observation: PortableValue;
    }
  | { readonly kind: "fail" | "unknown" | "cancel"; readonly id: string };

export interface ConcurrentHistory {
  readonly format: "modelt.concurrent-history";
  readonly version: 1;
  readonly model: string;
  readonly initial: PortableValue;
  readonly events: readonly HistoryEvent[];
}

export interface ConcurrentResult {
  readonly status:
    | "linearizable"
    | "not-linearizable"
    | "inconclusive"
    | "empty";
  readonly explored: number;
  readonly order: readonly string[];
  readonly omitted: readonly string[];
  readonly pending: readonly string[];
}

export interface HistoryRecorder {
  readonly invoke: (id: string, action: PortableValue) => void;
  readonly returned: (id: string, observation: PortableValue) => void;
  readonly end: (id: string, kind: "fail" | "unknown" | "cancel") => void;
  readonly snapshot: () => ConcurrentHistory;
}

export interface LoadedFiniteModel {
  readonly checkHistories: (
    traces: readonly PortableTrace[],
  ) => readonly PortableResult[];
  readonly checkHistory: (
    history: ConcurrentHistory,
    maxNodes: number,
  ) => ConcurrentResult;
  readonly checkConformance: (
    driver: Driver<PortableValue, PortableValue>,
    actions: readonly PortableValue[],
  ) => Promise<PortableResult>;
  readonly release: () => void;
}
export interface DeletionRange {
  readonly start: number;
  readonly count: number;
}
export interface ActionDependency {
  readonly producer: number;
  readonly consumer: number;
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
