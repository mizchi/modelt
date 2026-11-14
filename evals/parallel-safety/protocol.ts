import type {
  SafetyBounds,
  SafetyProgram,
  SafetyResult,
  SchedulingJob,
} from "../../src/contracts.js";

export interface ProgramEntry {
  readonly id: string;
  readonly program: SafetyProgram;
}
export interface SafetyJob extends SchedulingJob {
  readonly program: string;
  readonly bounds: SafetyBounds;
}
export type SafetyOutcome =
  | { readonly status: "ok"; readonly result: SafetyResult }
  | {
      readonly status: "error";
      readonly code: string;
      readonly message: string;
    };

export interface WorkerSetup {
  readonly backend: "wasm" | "native";
  readonly bytes: Uint8Array;
  readonly programs: readonly ProgramEntry[];
  readonly jobs: readonly SafetyJob[];
}
