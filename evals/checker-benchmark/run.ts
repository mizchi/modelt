import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { digest } from "../usable/provenance.js";
import { loadEngines } from "./engines.js";
import { runProcess } from "./process.js";
import {
  bounds,
  cases,
  order,
  type Route,
  routes,
  summarize,
  verify,
  warmRoutes,
} from "./protocol.js";
import { environment, sourceFingerprint } from "./provenance.js";

const java = process.argv[2];
const jar = process.argv[3];
const archive = process.argv[4];
const directory = process.argv[5];
assert.ok(
  java && jar && archive && directory,
  "Pass java, jar, JRE archive, new output directory",
);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const evidence: string[] = [];
const write = async (path: string, value: unknown) => {
  await writeFile(
    join(directory, path),
    `${JSON.stringify(value, null, 2)}\n`,
    { flag: "wx" },
  );
  evidence.push(path);
};
const source = await sourceFingerprint();
const reports: unknown[] = [];
interface Sample {
  readonly route: Route;
  readonly iteration: number;
  readonly warmup: boolean;
  readonly milliseconds: number;
  readonly value: unknown;
}
try {
  const manifest = {
    plan: "0016-checker-benchmark",
    ...source,
    commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    dirtyPaths: execFileSync("git", ["status", "--short"]).toString().trim(),
    startedAt: new Date().toISOString(),
    environment: await environment(java, jar, archive),
    warmup: 2,
    measurements: 7,
    bounds,
    tlc: { workers: 1, seed: 16, gc: "ParallelGC", heap: "default" },
    node: {
      workers: 1,
      heap: "default",
      livenessCheck: "final",
      version: "1.7.4",
    },
    timing:
      "Wall clock; process startup and source parsing included; no OS cache flush; warm API separate",
  };
  await write("manifest.json", manifest);
  for (const input of cases()) {
    await mkdir(join(directory, input.name));
    await write(`${input.name}/input.json`, input);
    const moduleName = /^---- MODULE (\w+) ----/m.exec(input.source)?.[1];
    assert.ok(moduleName);
    for (const [suffix, content] of [
      ["tla", input.source],
      ["cfg", input.config],
    ] as const) {
      const path = `${input.name}/${moduleName}.${suffix}`;
      await writeFile(join(directory, path), content, { flag: "wx" });
      evidence.push(path);
    }
  }
  for (const mode of ["process", "reused"] as const) {
    const engines =
      mode === "reused" ? await loadEngines(warmRoutes) : undefined;
    try {
      for (const input of cases()) {
        const samples: Sample[] = [];
        for (let iteration = 0; iteration < 9; iteration++) {
          for (const route of order(
            mode === "process" ? routes : warmRoutes,
            iteration,
          )) {
            const log = `${input.name}/${mode}-${iteration}-${route}.json`;
            const start = performance.now();
            const result =
              mode === "process"
                ? await runProcess(
                    route,
                    input,
                    join(directory, input.name),
                    join(directory, log),
                    java,
                    jar,
                  )
                : {
                    value: await engines?.run(
                      route === "tlc" ? "tla-ts" : route,
                      input,
                    ),
                    milliseconds: performance.now() - start,
                  };
            if (mode === "process") evidence.push(log);
            const sample = {
              route,
              iteration,
              warmup: iteration < 2,
              ...result,
            };
            await write(
              `${input.name}/${mode}-${iteration}-${route}-sample.json`,
              sample,
            );
            verify(result.value, input);
            samples.push(sample);
          }
        }
        const summaries = (mode === "process" ? routes : warmRoutes).map(
          (route) => ({
            route,
            ...summarize(
              samples
                .filter((sample) => !sample.warmup && sample.route === route)
                .map((sample) => sample.milliseconds),
            ),
          }),
        );
        reports.push({ name: input.name, mode, input, samples, summaries });
        console.log(JSON.stringify({ name: input.name, mode, summaries }));
      }
    } finally {
      await engines?.close();
    }
  }
  assert.equal(
    (await sourceFingerprint()).sourceVersion,
    source.sourceVersion,
    "Sources changed while measuring",
  );
  await write("benchmark.json", reports);
  await write("result.json", {
    status: "complete",
    plan: "0016-checker-benchmark",
    sourceVersion: source.sourceVersion,
    cases: cases().length,
    reports: reports.length,
    files: await Promise.all(
      evidence.map(async (path) => ({
        path,
        sha256: digest(await readFile(join(directory, path))),
      })),
    ),
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "checker-benchmark", status: "complete", sourceVersion: source.sourceVersion })}\n`,
  );
} catch (error) {
  await write("error.json", {
    status: "error",
    message: String(error),
    completed: reports,
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "checker-benchmark", status: "error", sourceVersion: source.sourceVersion })}\n`,
  );
  throw error;
}
