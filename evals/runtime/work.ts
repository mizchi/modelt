import type { ScheduledRun } from "../harness/scheduled-counter.js";
import type { KernelOptions, KernelResult } from "./table.js";

export type Work =
  | { readonly kind: "kernel"; readonly options: KernelOptions }
  | {
      readonly kind: "schedule";
      readonly ordering: readonly number[];
      readonly operations: number;
    };
export type WorkResult =
  | KernelResult
  | { readonly broken: ScheduledRun; readonly fixed: ScheduledRun };
export interface Reply {
  readonly result?: WorkResult;
  readonly error?: string;
}

export interface CompletedWork {
  readonly index: number;
  readonly result: WorkResult;
  readonly elapsedMs: number;
}
export interface WorkBatch {
  readonly completed: readonly CompletedWork[];
  readonly remaining: readonly number[];
  readonly elapsedMs: number;
}
