import { equalValues, isRecord, valueKey } from "./trace.js";

export interface Task<Payload> {
  readonly id: string;
  readonly key: string;
  readonly payload: Payload;
}
export interface TaskManifest<Payload> {
  readonly version: 1;
  readonly id: string;
  readonly workload: string;
  readonly sourceVersion: string;
  readonly tasks: readonly Task<Payload>[];
}
export interface TaskReport<Result> {
  readonly manifestId: string;
  readonly taskId: string;
  readonly sourceVersion: string;
  readonly status: "ok" | "error";
  readonly result: Result;
}

export class ShardProtocolError extends Error {
  override readonly name = "ShardProtocolError";
}

const hash = async (value: unknown): Promise<string> =>
  Array.from(
    new Uint8Array(
      await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(valueKey(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

export const createManifest = async <Payload>(
  identity: { readonly workload: string; readonly sourceVersion: string },
  jobs: readonly { readonly key: string; readonly payload: Payload }[],
): Promise<TaskManifest<Payload>> => {
  if (
    !identity.workload ||
    !identity.sourceVersion ||
    jobs.length === 0 ||
    jobs.some((job) => !job.key) ||
    new Set(jobs.map((job) => job.key)).size !== jobs.length
  )
    throw new ShardProtocolError("Invalid task manifest");
  const tasks = (
    await Promise.all(
      jobs.map(async (job) => ({
        ...job,
        id: await hash({
          version: 1,
          ...identity,
          key: job.key,
          payload: job.payload,
        }),
      })),
    )
  ).sort((left, right) => (left.id < right.id ? -1 : 1));
  const body = {
    version: 1 as const,
    workload: identity.workload,
    sourceVersion: identity.sourceVersion,
    tasks,
  };
  return { ...body, id: await hash(body) };
};

export const verifyManifest = async <Payload>(
  manifest: TaskManifest<Payload>,
): Promise<void> => {
  if (
    !isRecord(manifest) ||
    manifest.version !== 1 ||
    typeof manifest.workload !== "string" ||
    typeof manifest.sourceVersion !== "string" ||
    !Array.isArray(manifest.tasks) ||
    manifest.tasks.some(
      (task: unknown) =>
        !isRecord(task) ||
        typeof task.key !== "string" ||
        typeof task.id !== "string",
    )
  )
    throw new ShardProtocolError("Invalid manifest structure");
  const rebuilt = await createManifest(
    { workload: manifest.workload, sourceVersion: manifest.sourceVersion },
    manifest.tasks,
  );
  if (rebuilt.id !== manifest.id || !equalValues(rebuilt.tasks, manifest.tasks))
    throw new ShardProtocolError("Manifest integrity mismatch");
};

export const partitionTasks = <Payload>(
  manifest: TaskManifest<Payload>,
  index: number,
  count: number,
): readonly Task<Payload>[] => {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new RangeError("Invalid shard coordinates");
  return manifest.tasks.filter(
    (task) => Number.parseInt(task.id.slice(0, 8), 16) % count === index,
  );
};

export const mergeReports = async <Payload, Result>(
  manifest: TaskManifest<Payload>,
  reports: readonly TaskReport<Result>[],
) => {
  await verifyManifest(manifest);
  const expected = new Set(manifest.tasks.map((task) => task.id));
  const results = new Map<string, TaskReport<Result>>();
  const conflicts: string[] = [];
  let duplicateAttempts = 0;
  let errors = 0;
  for (const report of reports) {
    if (
      report.manifestId !== manifest.id ||
      report.sourceVersion !== manifest.sourceVersion ||
      !expected.has(report.taskId) ||
      (report.status !== "ok" && report.status !== "error")
    ) {
      conflicts.push(report.taskId);
      continue;
    }
    if (report.status === "error") {
      errors++;
      continue;
    }
    valueKey(report.result);
    const previous = results.get(report.taskId);
    if (previous) {
      duplicateAttempts++;
      if (!equalValues(previous.result, report.result))
        conflicts.push(report.taskId);
    } else results.set(report.taskId, report);
  }
  const missingTaskIds = [...expected].filter((id) => !results.has(id));
  return {
    status:
      conflicts.length > 0
        ? "conflict"
        : missingTaskIds.length > 0
          ? "partial"
          : "complete",
    expected: expected.size,
    completed: results.size,
    duplicateAttempts,
    errors,
    conflicts,
    missingTaskIds,
    results: [...results.values()],
  };
};
