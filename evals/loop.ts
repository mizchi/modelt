import { readPlan, runEvaluation } from "./runner.js";

const plan = await readPlan(
  process.argv[2] ?? "evals/plans/0001-longer-walk.json",
);
const iteration = process.argv[3] ?? `run-${Date.now()}`;
const output = process.argv[4] ?? "evals/runs";
const development = await runEvaluation(
  plan,
  "development",
  `${iteration}-development`,
  output,
);
console.log(
  `${development.runId}: ${development.status} / ${development.assessment}`,
);
if (development.status !== "complete") {
  process.exitCode = 1;
} else {
  const confirmation = await runEvaluation(
    plan,
    "confirmation",
    `${iteration}-confirmation`,
    output,
    development.runId,
  );
  console.log(
    `${confirmation.runId}: ${confirmation.status} / ${confirmation.assessment}`,
  );
  console.table(
    confirmation.comparisons.map((row) => ({
      fault: row.fault,
      baseline: row.baselineDetected,
      candidate: row.candidateDetected,
      gained: row.candidateOnly.length,
      lost: row.baselineOnly.length,
    })),
  );
  if (confirmation.status !== "complete") process.exitCode = 1;
}
