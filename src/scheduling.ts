import type {
  ScheduledCompletion,
  ScheduledExecutor,
  ScheduledRun,
  SchedulePlan,
  SchedulingBudget,
  SchedulingJob,
  SchedulingOptions,
  SchedulingProfile,
} from "./contracts.js";

export class SchedulingError extends Error {
  override readonly name = "SchedulingError";
}

export const planSchedule = (
  jobs: readonly SchedulingJob[],
  profiles: readonly SchedulingProfile[],
  budget: SchedulingBudget,
  options: SchedulingOptions,
): SchedulePlan => {
  if (
    !Number.isFinite(budget.durationMs) ||
    budget.durationMs < 0 ||
    !Number.isSafeInteger(budget.memoryBytes) ||
    budget.memoryBytes < 0 ||
    !Number.isSafeInteger(budget.maxWorkers) ||
    budget.maxWorkers < 1 ||
    !Number.isFinite(options.batchTargetMs) ||
    options.batchTargetMs < 0 ||
    !Number.isSafeInteger(options.maxBatchSize) ||
    options.maxBatchSize < 1 ||
    (options.policy !== "fifo" && options.policy !== "cost") ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length ||
    jobs.some(
      (job) =>
        typeof job.id !== "string" ||
        !job.id ||
        !Number.isFinite(job.estimatedMs) ||
        job.estimatedMs < 0 ||
        !Number.isSafeInteger(job.memoryBytes) ||
        job.memoryBytes < 0,
    ) ||
    new Set(profiles.map((profile) => profile.id)).size !== profiles.length ||
    profiles.some(
      (profile) =>
        typeof profile.id !== "string" ||
        !profile.id ||
        !Number.isSafeInteger(profile.workers) ||
        profile.workers < 1 ||
        !Number.isFinite(profile.startupMs) ||
        profile.startupMs < 0 ||
        !Number.isFinite(profile.costScale) ||
        profile.costScale <= 0 ||
        !Number.isSafeInteger(profile.fixedMemoryBytes) ||
        profile.fixedMemoryBytes < 0,
    )
  )
    throw new SchedulingError("Invalid scheduling inputs");
  const snapshot = jobs.map((job) => ({ ...job }));
  const ordered =
    options.policy === "cost"
      ? snapshot
          .map((job, index) => ({ job, index }))
          .sort(
            (left, right) =>
              right.job.estimatedMs - left.job.estimatedMs ||
              left.index - right.index,
          )
          .map((entry) => entry.job)
      : snapshot;
  const batches: string[][] = [];
  const costs: number[] = [];
  for (const job of ordered) {
    const batch = batches[batches.length - 1];
    const cost = costs[costs.length - 1];
    if (
      options.policy === "cost" &&
      batch &&
      cost !== undefined &&
      batch.length < options.maxBatchSize &&
      cost + job.estimatedMs <= options.batchTargetMs
    ) {
      batch.push(job.id);
      costs[costs.length - 1] = cost + job.estimatedMs;
    } else {
      batches.push([job.id]);
      costs.push(job.estimatedMs);
    }
  }
  const candidates: SchedulePlan[] = [];
  for (const profile of profiles) {
    if (profile.workers > budget.maxWorkers) continue;
    const estimatedMemoryBytes =
      profile.fixedMemoryBytes +
      profile.workers *
        jobs.reduce((maximum, job) => Math.max(maximum, job.memoryBytes), 0);
    if (estimatedMemoryBytes > budget.memoryBytes) continue;
    const available = Array.from({ length: profile.workers }, () => 0);
    for (const cost of costs) {
      const index = available.indexOf(Math.min(...available));
      available[index] = (available[index] ?? 0) + cost * profile.costScale;
    }
    const estimatedMs = profile.startupMs + Math.max(...available);
    if (!Number.isFinite(estimatedMs) || estimatedMs > budget.durationMs)
      continue;
    candidates.push({
      status: "planned",
      profile: profile.id,
      workers: profile.workers,
      estimatedMs,
      estimatedMemoryBytes,
      startupMs: profile.startupMs,
      durationMs: budget.durationMs,
      jobs: snapshot,
      batches,
    });
  }
  return (
    (jobs.length > 0
      ? candidates.sort(
          (left, right) =>
            left.estimatedMs - right.estimatedMs ||
            left.estimatedMemoryBytes - right.estimatedMemoryBytes ||
            left.workers - right.workers,
        )[0]
      : undefined) ?? {
      status:
        jobs.length === 0
          ? "empty"
          : profiles.length === 0
            ? "uncalibrated"
            : "insufficient-budget",
      profile: null,
      workers: 0,
      estimatedMs: 0,
      estimatedMemoryBytes: 0,
      startupMs: 0,
      durationMs: budget.durationMs,
      jobs: snapshot,
      batches,
    }
  );
};

export const runSchedule = async <Result>(
  plan: SchedulePlan,
  executors: readonly ScheduledExecutor<Result>[],
  durationMs = Math.max(0, plan.durationMs - plan.startupMs),
): Promise<ScheduledRun<Result>> => {
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new SchedulingError("Invalid dispatch budget");
  const ids = plan.jobs.map((job) => job.id);
  const expectedIds = new Set(ids);
  const batches = plan.batches.map((batch) => Object.freeze([...batch]));
  const selected = batches.flat();
  if (
    expectedIds.size !== ids.length ||
    new Set(selected).size !== selected.length ||
    ids.length !== selected.length ||
    selected.some((id) => !expectedIds.has(id)) ||
    batches.some((batch) => batch.length === 0) ||
    (plan.status === "planned" &&
      (executors.length !== plan.workers || plan.workers < 1))
  )
    throw new SchedulingError("Invalid schedule or executor count");
  const started = performance.now();
  const completed = new Map<string, ScheduledCompletion<Result>>();
  const dispatches: {
    worker: number;
    ids: readonly string[];
    queuedMs: number;
    elapsedMs: number;
    error: string | null;
  }[] = [];
  let cursor = 0;
  if (plan.status === "planned")
    await Promise.all(
      executors.map(async (executor, worker) => {
        while (
          cursor < batches.length &&
          performance.now() - started < durationMs
        ) {
          const batch = batches[cursor++];
          if (!batch) throw new SchedulingError("Missing batch");
          const begin = performance.now();
          try {
            const result = await executor.execute(batch);
            if (
              result.length !== batch.length ||
              new Set(result.map((entry) => entry.id)).size !== batch.length ||
              result.some((entry) => !batch.includes(entry.id))
            )
              throw new SchedulingError(
                "Incomplete or conflicting worker response",
              );
            for (const entry of result) completed.set(entry.id, entry);
            dispatches.push({
              worker,
              ids: batch,
              queuedMs: begin - started,
              elapsedMs: performance.now() - begin,
              error: null,
            });
          } catch (error) {
            dispatches.push({
              worker,
              ids: batch,
              queuedMs: begin - started,
              elapsedMs: performance.now() - begin,
              error: error instanceof Error ? error.message : String(error),
            });
            break;
          }
        }
      }),
    );
  const remaining = ids.filter((id) => !completed.has(id));
  return {
    executionStatus: remaining.length === 0 ? "complete" : "partial",
    completed: ids.flatMap((id) => {
      const entry = completed.get(id);
      return entry ? [entry] : [];
    }),
    remaining,
    elapsedMs: performance.now() - started,
    dispatches,
  };
};

export type {
  ScheduledCompletion,
  ScheduledExecutor,
  ScheduledRun,
  SchedulePlan,
  SchedulingBudget,
  SchedulingJob,
  SchedulingOptions,
  SchedulingProfile,
} from "./contracts.js";
