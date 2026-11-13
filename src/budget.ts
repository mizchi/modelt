export interface RuntimeProfile {
  readonly id: string;
  readonly workload: string;
  readonly workers: number;
  readonly startupMs: number;
  readonly visitsPerMs: number;
  readonly fixedMemoryBytes: number;
  readonly bytesPerState: number;
}

export interface ExecutionBudget {
  readonly workload: string;
  readonly durationMs: number;
  readonly memoryBytes: number;
  readonly maxWorkers: number;
  readonly maxDepth: number;
  readonly branching: number;
}

export interface BudgetPlan {
  readonly status: "planned" | "uncalibrated" | "insufficient-budget";
  readonly workload: string;
  readonly profile: string | null;
  readonly workers: number;
  readonly maxDepth: number;
  readonly maxStates: number;
  readonly estimatedMs: number;
  readonly estimatedMemoryBytes: number;
}

export const planBudget = (
  budget: ExecutionBudget,
  profiles: readonly RuntimeProfile[],
): BudgetPlan => {
  if (
    !Number.isFinite(budget.durationMs) ||
    budget.durationMs < 0 ||
    !Number.isSafeInteger(budget.memoryBytes) ||
    budget.memoryBytes < 0 ||
    !Number.isSafeInteger(budget.maxWorkers) ||
    budget.maxWorkers < 1 ||
    !Number.isSafeInteger(budget.maxDepth) ||
    budget.maxDepth < 0 ||
    !Number.isSafeInteger(budget.branching) ||
    budget.branching < 0
  )
    throw new RangeError("Invalid execution budget");
  for (const profile of profiles) {
    if (
      !Number.isSafeInteger(profile.workers) ||
      profile.workers < 1 ||
      !Number.isFinite(profile.startupMs) ||
      profile.startupMs < 0 ||
      !Number.isFinite(profile.visitsPerMs) ||
      profile.visitsPerMs <= 0 ||
      !Number.isSafeInteger(profile.fixedMemoryBytes) ||
      profile.fixedMemoryBytes < 0 ||
      !Number.isSafeInteger(profile.bytesPerState) ||
      profile.bytesPerState < 0
    )
      throw new RangeError("Invalid runtime profile");
  }
  const matching = profiles.filter(
    (profile) => profile.workload === budget.workload,
  );
  const candidates: BudgetPlan[] = [];
  for (const profile of matching) {
    if (
      profile.workers > budget.maxWorkers ||
      budget.memoryBytes < profile.fixedMemoryBytes
    )
      continue;
    const capacity = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.floor((budget.durationMs - profile.startupMs) * profile.visitsPerMs),
      profile.bytesPerState === 0
        ? Number.MAX_SAFE_INTEGER
        : Math.floor(
            (budget.memoryBytes - profile.fixedMemoryBytes) /
              profile.bytesPerState,
          ),
    );
    if (capacity < 1) continue;
    let depth = 0;
    let states = 1;
    let level = 1;
    if (budget.branching === 1) {
      depth = Math.min(budget.maxDepth, capacity - 1);
      states = depth + 1;
    } else if (budget.branching > 1) {
      while (
        depth < budget.maxDepth &&
        level <= (capacity - states) / budget.branching
      ) {
        level *= budget.branching;
        states += level;
        depth++;
      }
    }
    candidates.push({
      status: "planned",
      workload: budget.workload,
      profile: profile.id,
      workers: profile.workers,
      maxDepth: depth,
      maxStates: states,
      estimatedMs: profile.startupMs + states / profile.visitsPerMs,
      estimatedMemoryBytes:
        profile.fixedMemoryBytes + states * profile.bytesPerState,
    });
  }
  return (
    candidates.sort(
      (left, right) =>
        right.maxDepth - left.maxDepth ||
        right.maxStates - left.maxStates ||
        left.estimatedMs - right.estimatedMs ||
        left.workers - right.workers,
    )[0] ?? {
      status: matching.length === 0 ? "uncalibrated" : "insufficient-budget",
      workload: budget.workload,
      profile: null,
      workers: 0,
      maxDepth: 0,
      maxStates: 0,
      estimatedMs: 0,
      estimatedMemoryBytes: 0,
    }
  );
};
