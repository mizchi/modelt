import { schedulerFor } from "fast-check";
import type { Operation } from "./history.js";

export interface ScheduledRun {
  readonly mode: "concurrent" | "sequential";
  readonly ordering: readonly number[];
  readonly history: readonly Operation<number, number>[];
  readonly events: readonly {
    readonly id: number;
    readonly label: string;
    readonly status: string;
  }[];
}

export const interleavings: readonly (readonly number[])[] = [
  [1, 3, 2, 4],
  [1, 2, 3, 4],
  [1, 2, 4, 3],
  [2, 3, 1, 4],
  [2, 1, 3, 4],
  [2, 1, 4, 3],
];

export const runScheduledCounter = async (
  lostUpdate: boolean,
  ordering: readonly number[],
  mode: "concurrent" | "sequential" = "concurrent",
  operations = 2,
): Promise<ScheduledRun> => {
  const scheduler = schedulerFor([...ordering]);
  let value = 0;
  let event = 0;
  const history: Operation<number, number>[] = [];
  const increment = async (id: string): Promise<void> => {
    const call = event++;
    await scheduler.schedule(Promise.resolve(), `${id}:read`);
    const snapshot = value;
    await scheduler.schedule(Promise.resolve(), `${id}:write`);
    value = (lostUpdate ? snapshot : value) + 1;
    const output = value;
    history.push({ id, call, returned: event++, input: 1, output });
  };
  if (!Number.isSafeInteger(operations) || operations < 1)
    throw new RangeError("Invalid concurrent operation count");
  const ids = Array.from({ length: operations }, (_, index) =>
    index < 26 ? String.fromCharCode(97 + index) : String(index),
  );
  if (mode === "sequential") {
    for (const id of ids) await scheduler.waitFor(increment(id));
  } else {
    await scheduler.waitFor(Promise.all(ids.map(increment)));
  }
  return {
    mode,
    ordering: [...ordering],
    history,
    events: scheduler.report().map((entry) => ({
      id: entry.taskId,
      label: entry.label,
      status: entry.status,
    })),
  };
};
