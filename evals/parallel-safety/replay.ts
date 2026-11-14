import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ScheduledCompletion,
  SchedulingProfile,
} from "../../src/contracts.js";
import { planSchedule, runSchedule } from "../../src/scheduling.js";
import { verifyManifest } from "../../src/sharding.js";
import { nativePath, wasmPath } from "../checker-benchmark/engines.js";
import { digest } from "../usable/provenance.js";
import { corpus } from "./corpus.js";
import type { Sample } from "./evaluate.js";
import { createNodePool } from "./node-pool.js";
import type { SafetyOutcome } from "./protocol.js";
import { fingerprint } from "./provenance.js";

const saved = process.argv[2];
const directory = process.argv[3];
assert.ok(saved && directory, "Pass saved run and new replay directory");
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
try {
  const result = JSON.parse(await readFile(join(saved, "result.json"), "utf8"));
  assert.equal(result.status, "complete");
  assert.equal(
    result.sourceVersion,
    (await fingerprint()).sourceVersion,
    "Check out recorded sources",
  );
  for (const file of result.files) {
    assert.ok(
      typeof file.path === "string" &&
        !file.path.includes("..") &&
        !file.path.startsWith("/"),
    );
    assert.equal(
      digest(await readFile(join(saved, file.path))),
      file.sha256,
      `Changed evidence: ${file.path}`,
    );
  }
  const manifest = JSON.parse(
    await readFile(join(saved, "manifest.json"), "utf8"),
  );
  const bytes = await readFile(wasmPath);
  assert.equal(digest(bytes), manifest.wasmSha256);
  assert.equal(digest(await readFile(nativePath)), manifest.nativeSha256);
  const data = await corpus(result.sourceVersion);
  await verifyManifest(data.manifest);
  assert.deepEqual(
    JSON.parse(await readFile(join(saved, "inputs.json"), "utf8")),
    data,
  );
  const expected: Record<
    string,
    readonly ScheduledCompletion<SafetyOutcome>[]
  > = JSON.parse(await readFile(join(saved, "expected.json"), "utf8"));
  assert.deepEqual(expected.wasm, expected.native);
  const calibration = JSON.parse(
    await readFile(join(saved, "calibration.json"), "utf8"),
  );
  const samples: Sample[] = (
    await readFile(join(saved, "samples.jsonl"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(samples.length, 288);
  assert.equal(result.samples, samples.length);
  assert.equal(result.measurements, 224);
  const identities = new Set<string>();
  for (const sample of samples) {
    const key = `${sample.backend}/${sample.workers}/${sample.workload}/${sample.policy}/${sample.iteration}`;
    assert.ok(!identities.has(key));
    identities.add(key);
    assert.ok(
      [1, 2, 4, 8].includes(sample.workers) &&
        sample.iteration >= 0 &&
        sample.iteration < 9,
    );
    assert.equal(sample.warmup, sample.iteration < 2);
    assert.ok(Number.isFinite(sample.elapsedMs) && sample.elapsedMs > 0);
    const selected = data.jobs.filter(
      (job) =>
        data.manifest.tasks.find((task) => task.id === job.id)?.payload
          .workload === sample.workload,
    );
    const reference = expected[sample.backend]?.filter((entry) =>
      selected.some((job) => job.id === entry.id),
    );
    assert.equal(sample.outcomeSha256, digest(JSON.stringify(reference)));
    const dispatched = sample.dispatches
      .flatMap((dispatch) => dispatch.ids)
      .sort();
    assert.deepEqual(dispatched, selected.map((job) => job.id).sort());
    assert.ok(
      sample.dispatches.every(
        (dispatch) =>
          dispatch.error === null && dispatch.worker < sample.workers,
      ),
    );
  }
  const replayed = [];
  for (const backend of ["wasm", "native"] as const) {
    const jobs = data.jobs.map((job) => ({
      ...job,
      estimatedMs: calibration.costs[backend][job.program],
    }));
    const pool = await createNodePool(4, {
      backend,
      bytes,
      programs: data.programs,
      jobs,
    });
    try {
      for (const workload of ["mixed", "tiny"])
        for (const policy of ["fifo", "cost"] as const) {
          const selected = jobs.filter(
            (job) =>
              data.manifest.tasks.find((task) => task.id === job.id)?.payload
                .workload === workload,
          );
          const profiles: SchedulingProfile[] = [
            {
              id: "replay",
              workers: 4,
              startupMs: 0,
              costScale: 1,
              fixedMemoryBytes: 0,
            },
          ];
          const plan = planSchedule(
            selected,
            profiles,
            { durationMs: 120000, memoryBytes: 8 * 1024 ** 3, maxWorkers: 4 },
            { policy, batchTargetMs: 4, maxBatchSize: 16 },
          );
          const actual = await runSchedule(plan, pool.executors);
          assert.equal(actual.executionStatus, "complete");
          assert.deepEqual(
            actual.completed,
            expected[backend]?.filter((entry) =>
              selected.some((job) => job.id === entry.id),
            ),
          );
          replayed.push({ backend, workload, policy, actual });
        }
    } finally {
      await pool.close();
    }
  }
  await writeFile(
    join(directory, "result.json"),
    `${JSON.stringify(
      {
        status: "complete",
        saved,
        sourceVersion: result.sourceVersion,
        replayed,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  console.log(
    "Verified 288 saved samples; reproduced 1,376 task checks in reused native/Wasm pools",
  );
} catch (error) {
  await writeFile(
    join(directory, "error.json"),
    JSON.stringify({ status: "error", message: String(error) }),
    { flag: "wx" },
  );
  throw error;
}
