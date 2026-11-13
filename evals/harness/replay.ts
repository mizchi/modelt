import { readFile } from "node:fs/promises";
import {
  counterModel,
  isCounterAction,
  isCounterObservation,
} from "../../examples/durable-counter.js";
import {
  checkConformance,
  decodeTrace,
  TraceFormatError,
} from "../../src/index.js";
import { isRecord } from "../../src/trace.js";
import { counterFaults, createFaultyCounter } from "./counter-faults.js";
import { checkHistory, incrementHistoryModel } from "./history.js";
import { runScheduledCounter } from "./scheduled-counter.js";

const document: unknown = JSON.parse(
  await readFile(
    process.argv[2] ?? ".artifacts/evaluation/witnesses.json",
    "utf8",
  ),
);
if (
  !isRecord(document) ||
  !isRecord(document.search) ||
  !Array.isArray(document.schedules)
)
  throw new TraceFormatError("Invalid evaluation evidence");
for (const fault of counterFaults) {
  const witness = document.search[fault];
  if (!isRecord(witness))
    throw new TraceFormatError(`Missing ${fault} witness`);
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
    throw new Error(`${fault} did not reproduce`);
  console.log(
    `${fault}: reproduced at step ${broken.checkedSteps}; fixed implementation passed`,
  );
}
for (const schedule of document.schedules) {
  if (!isRecord(schedule) || !Array.isArray(schedule.ordering))
    throw new TraceFormatError("Invalid schedule evidence");
  const ordering = schedule.ordering.map((id: unknown) => {
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
      throw new TraceFormatError("Invalid scheduling choice");
    return id;
  });
  const broken = await runScheduledCounter(true, ordering);
  const fixed = await runScheduledCounter(false, ordering);
  if (
    JSON.stringify(broken.history) !== JSON.stringify(schedule.history) ||
    checkHistory(incrementHistoryModel, fixed.history, 100).status !==
      "linearizable"
  )
    throw new Error("Schedule did not reproduce");
}
console.log(
  `${document.schedules.length} schedules replayed; fixed implementation passed`,
);
