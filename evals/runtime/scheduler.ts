import {
  type ExecutionBudget,
  planBudget,
  type RuntimeProfile,
} from "../../src/budget.js";
import { checkHistory, incrementHistoryModel } from "../harness/history.js";
import { createPool, runInline } from "./pool.js";
import { enumerateSchedules } from "./schedules.js";
import type { Work } from "./work.js";

export const executeScheduledBudget = async (
  operations: number,
  budget: ExecutionBudget,
  profiles: readonly RuntimeProfile[],
) => {
  if (budget.workload !== `async-counter-${operations}`)
    throw new Error("Schedule workload does not match its calibration");
  const plan = planBudget(budget, profiles);
  const start = performance.now();
  if (plan.status !== "planned")
    return {
      status: "budget-exhausted",
      plan,
      checked: 0,
      coverageComplete: false,
      counterexamples: [],
      elapsedMs: performance.now() - start,
    };
  const schedules = enumerateSchedules(
    operations,
    plan.maxDepth,
    plan.maxStates,
  );
  const jobs: Work[] = schedules.orders.map((ordering) => ({
    kind: "schedule",
    operations,
    ordering,
  }));
  const deadline = start + budget.durationMs;
  const pool = plan.profile?.startsWith("inline-")
    ? null
    : await createPool(plan.workers);
  try {
    const batch = pool
      ? await pool.run(jobs, deadline)
      : await runInline(jobs, deadline);
    const counterexamples = [];
    for (const item of batch.completed) {
      if (!("broken" in item.result))
        throw new Error("Unexpected scheduler result");
      if (
        checkHistory(incrementHistoryModel, item.result.fixed.history, 10000)
          .status !== "linearizable"
      )
        throw new Error("Normal scheduler control failed");
      if (
        checkHistory(incrementHistoryModel, item.result.broken.history, 10000)
          .status === "not-linearizable"
      )
        counterexamples.push(item.result.broken);
    }
    const coverageComplete = !schedules.bounded && batch.remaining.length === 0;
    return {
      status:
        counterexamples.length > 0
          ? "violation"
          : coverageComplete
            ? "complete"
            : "budget-exhausted",
      plan,
      checked: batch.completed.length,
      coverageComplete,
      counterexamples,
      remaining: batch.remaining.length,
      elapsedMs: performance.now() - start,
    };
  } finally {
    await pool?.close();
  }
};
