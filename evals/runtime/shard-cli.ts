import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createManifest,
  mergeReports,
  partitionTasks,
  type TaskManifest,
  type TaskReport,
  verifyManifest,
} from "../../src/sharding.js";
import { isRecord } from "../../src/trace.js";
import { createPool } from "./pool.js";
import { runtimeFingerprint } from "./provenance.js";
import { enumerateSchedules } from "./schedules.js";
import { validateKernelOptions } from "./table.js";
import type { Work } from "./work.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));
const writeJson = async (path: string, value: unknown) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
};
const parseWork = (value: unknown): Work => {
  if (!isRecord(value)) throw new Error("Invalid shard work");
  if (
    value.kind === "schedule" &&
    typeof value.operations === "number" &&
    Number.isSafeInteger(value.operations) &&
    value.operations > 0 &&
    Array.isArray(value.ordering)
  ) {
    const ordering = value.ordering.map((id: unknown) => {
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1)
        throw new Error("Invalid schedule ID");
      return id;
    });
    if (ordering.length !== value.operations * 2)
      throw new Error("Incomplete scheduled task");
    return { kind: "schedule", operations: value.operations, ordering };
  }
  if (value.kind === "kernel" && isRecord(value.options)) {
    const options = value.options;
    if (
      typeof options.seed !== "number" ||
      typeof options.operations !== "number" ||
      typeof options.depth !== "number" ||
      typeof options.strategy !== "number" ||
      typeof options.repeats !== "number" ||
      typeof options.trace !== "boolean"
    )
      throw new Error("Invalid kernel task");
    const parsed = {
      seed: options.seed,
      operations: options.operations,
      depth: options.depth,
      strategy: options.strategy,
      repeats: options.repeats,
      trace: options.trace,
    };
    validateKernelOptions(parsed);
    return { kind: "kernel", options: parsed };
  }
  throw new Error("Unsupported shard task");
};
const readManifest = async (path: string): Promise<TaskManifest<Work>> => {
  const value = await readJson(path);
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.id !== "string" ||
    typeof value.workload !== "string" ||
    typeof value.sourceVersion !== "string" ||
    !Array.isArray(value.tasks)
  )
    throw new Error("Invalid shard manifest");
  const tasks = value.tasks.map((task: unknown) => {
    if (
      !isRecord(task) ||
      typeof task.id !== "string" ||
      typeof task.key !== "string"
    )
      throw new Error("Invalid task envelope");
    return { id: task.id, key: task.key, payload: parseWork(task.payload) };
  });
  const manifest = {
    version: 1 as const,
    id: value.id,
    workload: value.workload,
    sourceVersion: value.sourceVersion,
    tasks,
  };
  await verifyManifest(manifest);
  return manifest;
};
const command = process.argv[2];
if (command === "prepare") {
  const target = process.argv[3];
  if (!target) throw new Error("prepare requires a manifest path");
  const fingerprint = await runtimeFingerprint();
  const jobs = Array.from({ length: 40 }, (_, index) => ({
    key: `kernel-seed-${61 + index}`,
    payload: {
      kind: "kernel" as const,
      options: {
        seed: 61 + index,
        operations: 512,
        depth: 16,
        strategy: 1,
        repeats: 1,
        trace: false,
      },
    },
  }));
  const schedules = [2, 3].flatMap((operations) =>
    enumerateSchedules(operations, operations * 2, 10000).orders.map(
      (ordering, index) => ({
        key: `schedule-${operations}-${index}`,
        payload: { kind: "schedule" as const, operations, ordering },
      }),
    ),
  );
  const manifest = await createManifest<Work>(
    { workload: "runtime-0003", sourceVersion: fingerprint.sourceVersion },
    [...jobs, ...schedules],
  );
  await writeJson(target, manifest);
  console.log(
    `${manifest.tasks.length} independent tasks; manifest ${manifest.id}`,
  );
} else if (command === "run") {
  const path = process.argv[3];
  const target = process.argv[6];
  if (!path || !target)
    throw new Error(
      "run requires manifest index count output [workers] [durationMs]",
    );
  const manifest = await readManifest(path);
  const fingerprint = await runtimeFingerprint();
  if (fingerprint.sourceVersion !== manifest.sourceVersion)
    throw new Error("Shard source version differs from the manifest");
  const index = Number(process.argv[4]);
  const count = Number(process.argv[5]);
  const tasks = partitionTasks(manifest, index, count);
  const workers = Number(process.argv[7] ?? 1);
  const durationMs = Number(process.argv[8] ?? 1000);
  if (!Number.isFinite(durationMs) || durationMs < 0)
    throw new RangeError("Invalid shard time budget");
  await mkdir(dirname(target), { recursive: true });
  await mkdir(target, { recursive: false });
  await writeJson(join(target, "manifest.json"), {
    manifestId: manifest.id,
    sourceVersion: manifest.sourceVersion,
    shardIndex: index,
    shardCount: count,
    workers,
    durationMs,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });
  const reports: TaskReport<unknown>[] = [];
  const start = performance.now();
  const pool = await createPool(workers);
  try {
    const result = await pool.run(
      tasks.map((task) => task.payload),
      start + durationMs,
    );
    for (const item of result.completed) {
      const task = tasks[item.index];
      if (!task) throw new Error("Shard task mismatch");
      reports.push({
        manifestId: manifest.id,
        sourceVersion: manifest.sourceVersion,
        taskId: task.id,
        status: "ok",
        result: item.result,
      });
    }
    await writeJson(join(target, "reports.json"), reports);
    await writeJson(join(target, "result.json"), {
      status: result.remaining.length > 0 ? "budget-exhausted" : "complete",
      requested: tasks.length,
      completed: reports.length,
      elapsedMs: performance.now() - start,
      startupMs: pool.startupMs,
      remainingTaskIds: result.remaining.map((position) => tasks[position]?.id),
    });
    console.log(
      `shard ${index}/${count}: ${reports.length}/${tasks.length} tasks`,
    );
  } catch (error) {
    await writeJson(join(target, "error.json"), {
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await pool.close();
  }
} else if (command === "merge" || command === "merge-directory") {
  const path = process.argv[3];
  const target = process.argv[4];
  if (!path || !target || process.argv.length < 6)
    throw new Error("merge requires manifest output reports...");
  const manifest = await readManifest(path);
  const collect = async (directory: string): Promise<string[]> => {
    try {
      return (
        await Promise.all(
          (
            await readdir(directory, { withFileTypes: true })
          ).map((entry) =>
            entry.isDirectory()
              ? collect(join(directory, entry.name))
              : entry.name === "reports.json"
                ? [join(directory, entry.name)]
                : [],
          ),
        )
      ).flat();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }
  };
  const files =
    command === "merge-directory"
      ? await collect(process.argv[5] ?? "")
      : process.argv.slice(5);
  const reports = (
    await Promise.all(
      files.map(async (file): Promise<TaskReport<unknown>[]> => {
        const value = await readJson(file);
        if (!Array.isArray(value)) throw new Error("Invalid shard reports");
        return value.map((report: unknown) => {
          if (
            !isRecord(report) ||
            typeof report.manifestId !== "string" ||
            typeof report.sourceVersion !== "string" ||
            typeof report.taskId !== "string" ||
            (report.status !== "ok" && report.status !== "error")
          )
            throw new Error("Invalid shard report");
          return {
            manifestId: report.manifestId,
            sourceVersion: report.sourceVersion,
            taskId: report.taskId,
            status: report.status,
            result: report.result,
          };
        });
      }),
    )
  ).flat();
  const result = await mergeReports(manifest, reports);
  await writeJson(target, result);
  console.log(
    `${result.status}: ${result.completed}/${result.expected}; retries ${result.duplicateAttempts}`,
  );
  if (result.status !== "complete") process.exitCode = 1;
} else throw new Error("Expected prepare, run or merge");
