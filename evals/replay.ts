import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  counterModel,
  isCounterAction,
  isCounterObservation,
} from "../examples/durable-counter.js";
import { checkConformance, decodeTrace } from "../src/index.js";
import { isRecord } from "../src/trace.js";
import {
  counterFaults,
  createFaultyCounter,
} from "./harness/counter-faults.js";
import { EvaluationProtocolError, isRunId } from "./protocol.js";
import { readCompletedRun } from "./runner.js";

const directory =
  process.argv[2] ??
  (await (async () => {
    const lines = (await readFile("evals/runs/ledger.jsonl", "utf8"))
      .trim()
      .split("\n");
    for (const line of lines.toReversed()) {
      const entry: unknown = JSON.parse(line);
      if (
        isRecord(entry) &&
        entry.split === "confirmation" &&
        entry.status === "complete" &&
        typeof entry.runId === "string" &&
        isRunId(entry.runId)
      )
        return join("evals/runs", entry.runId);
    }
    throw new EvaluationProtocolError(
      "No completed confirmation run to replay",
    );
  })());
const evidence = await readCompletedRun(directory);
const witnesses = evidence.witnesses;
if (!isRecord(witnesses))
  throw new EvaluationProtocolError("Run is incomplete or controls failed");
const entries = Object.entries(witnesses);
if (entries.length === 0)
  throw new EvaluationProtocolError(
    "Run has no failure witnesses; nothing to reproduce",
  );
for (const [key, witness] of entries) {
  const fault = counterFaults.find((name) => key.endsWith(`/${name}`));
  if (!fault || !isRecord(witness))
    throw new EvaluationProtocolError("Invalid failure witness");
  const trace = decodeTrace(JSON.stringify(witness.trace), {
    action: isCounterAction,
    observation: isCounterObservation,
  });
  const actions = trace.steps.map((step) => step.action);
  const broken = await checkConformance(
    counterModel,
    createFaultyCounter(fault),
    actions,
  );
  const fixed = await checkConformance(
    counterModel,
    createFaultyCounter("none"),
    actions,
  );
  if (broken.status !== "mismatch" || fixed.status !== "matched")
    throw new EvaluationProtocolError(`${key} did not reproduce`);
}
console.log(
  `${directory}: ${entries.length} witnesses reproduced; normal controls passed`,
);
