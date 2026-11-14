import type {
  SafetyBounds,
  SafetyProgram,
  SafetyResult,
  ScheduledCompletion,
} from "../../src/contracts.js";
import { PortableCoreError } from "../../src/portable-value.js";
import { SchedulingError } from "../../src/scheduling.js";
import type { ProgramEntry, SafetyJob, SafetyOutcome } from "./protocol.js";

export const createProcessor = (
  programs: readonly ProgramEntry[],
  jobs: readonly SafetyJob[],
  check: (
    program: SafetyProgram,
    bounds: SafetyBounds,
  ) => Promise<SafetyResult>,
) => {
  const registered = new Map(
    programs.map((entry) => [entry.id, structuredClone(entry.program)]),
  );
  const tasks = new Map(jobs.map((job) => [job.id, structuredClone(job)]));
  if (
    registered.size !== programs.length ||
    tasks.size !== jobs.length ||
    jobs.some((job) => !registered.has(job.program))
  )
    throw new SchedulingError("Invalid worker registry");
  return async (
    ids: readonly string[],
  ): Promise<readonly ScheduledCompletion<SafetyOutcome>[]> => {
    if (new Set(ids).size !== ids.length || ids.some((id) => !tasks.has(id)))
      throw new SchedulingError("Unknown or duplicate task");
    const completed: ScheduledCompletion<SafetyOutcome>[] = [];
    for (const id of ids) {
      const job = tasks.get(id);
      const program = job && registered.get(job.program);
      if (!job || !program) throw new SchedulingError("Missing worker program");
      try {
        completed.push({
          id,
          result: { status: "ok", result: await check(program, job.bounds) },
        });
      } catch (error) {
        if (!(error instanceof PortableCoreError)) throw error;
        completed.push({
          id,
          result: { status: "error", code: error.code, message: error.message },
        });
      }
    }
    return completed;
  };
};
