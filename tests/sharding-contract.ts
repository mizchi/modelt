import assert from "node:assert/strict";
import {
  createManifest,
  mergeReports,
  partitionTasks,
} from "../src/sharding.js";

export const registerShardingContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("sharding preserves task identities and exactly covers the manifest", async () => {
    const jobs = Array.from({ length: 20 }, (_, seed) => ({
      key: `seed-${seed}`,
      payload: { seed },
    }));
    const manifest = await createManifest(
      { workload: "test", sourceVersion: "source-a" },
      jobs,
    );
    const reordered = await createManifest(
      { workload: "test", sourceVersion: "source-a" },
      jobs.toReversed(),
    );
    assert.equal(manifest.id, reordered.id);
    const partitions = Array.from({ length: 4 }, (_, index) =>
      partitionTasks(manifest, index, 4),
    );
    assert.equal(new Set(partitions.flat().map((task) => task.id)).size, 20);
    assert.deepEqual(
      partitions
        .flat()
        .map((task) => task.id)
        .sort(),
      manifest.tasks.map((task) => task.id).sort(),
    );
    assert.throws(() => partitionTasks(manifest, 4, 4), RangeError);
  });
  test("cloud aggregation distinguishes missing tasks, retries, errors and incompatible results", async () => {
    const manifest = await createManifest(
      { workload: "test", sourceVersion: "source-a" },
      [
        { key: "a", payload: 1 },
        { key: "b", payload: 2 },
      ],
    );
    const rows = manifest.tasks.map((task) => ({
      manifestId: manifest.id,
      taskId: task.id,
      sourceVersion: "source-a",
      status: "ok" as const,
      result: { value: task.payload },
    }));
    assert.equal((await mergeReports(manifest, rows)).status, "complete");
    assert.equal(
      (await mergeReports(manifest, rows.slice(0, 1))).status,
      "partial",
    );
    assert.equal(
      (await mergeReports(manifest, [...rows, ...rows])).duplicateAttempts,
      2,
    );
    assert.equal(
      (
        await mergeReports(manifest, [
          ...rows,
          {
            ...rows[0],
            manifestId: manifest.id,
            taskId: rows[0]?.taskId ?? "",
            sourceVersion: "source-a",
            status: "ok",
            result: { value: 99 },
          },
        ])
      ).status,
      "conflict",
    );
    assert.equal(
      (
        await mergeReports(
          manifest,
          rows.map((row) => ({ ...row, sourceVersion: "other" })),
        )
      ).status,
      "conflict",
    );
    assert.equal(
      (
        await mergeReports(
          manifest,
          rows.map((row) => ({
            ...row,
            status: "error" as const,
            result: { value: -1 },
          })),
        )
      ).status,
      "partial",
    );
    assert.equal(
      (
        await mergeReports(manifest, [
          ...rows.map((row) => ({ ...row, status: "error" as const })),
          ...rows,
        ])
      ).status,
      "complete",
    );
  });
};
