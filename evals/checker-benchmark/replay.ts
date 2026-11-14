import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest } from "../usable/provenance.js";
import { loadEngines } from "./engines.js";
import { runProcess } from "./process.js";
import { cases, routes, summarize, verify, warmRoutes } from "./protocol.js";
import { environment, sourceFingerprint } from "./provenance.js";

const java = process.argv[2];
const jar = process.argv[3];
const archive = process.argv[4];
const saved = process.argv[5];
const directory = process.argv[6];
assert.ok(
  java && jar && archive && saved && directory,
  "Pass java, jar, JRE archive, saved run, new replay directory",
);
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
try {
  const result = JSON.parse(await readFile(join(saved, "result.json"), "utf8"));
  assert.equal(result.status, "complete");
  assert.equal(
    result.sourceVersion,
    (await sourceFingerprint()).sourceVersion,
    "Check out recorded sources",
  );
  assert.equal(result.cases, cases().length);
  assert.equal(result.reports, cases().length * 2);
  assert.equal(
    new Set(result.files.map((file: { path: string }) => file.path)).size,
    result.files.length,
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
  assert.equal(manifest.sourceVersion, result.sourceVersion);
  const current = await environment(java, jar, archive);
  assert.deepEqual(
    current.binaries.map((binary) => binary.sha256),
    manifest.environment.binaries.map(
      (binary: { sha256: string }) => binary.sha256,
    ),
  );
  const reports = JSON.parse(
    await readFile(join(saved, "benchmark.json"), "utf8"),
  );
  assert.equal(reports.length, result.reports);
  assert.deepEqual(
    reports.map(
      (report: { name: string; mode: string }) =>
        `${report.mode}/${report.name}`,
    ),
    ["process", "reused"].flatMap((mode) =>
      cases().map((input) => `${mode}/${input.name}`),
    ),
  );
  const engines = await loadEngines(warmRoutes);
  const replayed = [];
  try {
    for (const input of cases()) {
      assert.deepEqual(
        JSON.parse(
          await readFile(join(saved, input.name, "input.json"), "utf8"),
        ),
        input,
      );
      for (const report of reports.filter(
        (report: { name: string }) => report.name === input.name,
      )) {
        assert.deepEqual(report.input, input);
        const activeRoutes = report.mode === "process" ? routes : warmRoutes;
        assert.equal(report.samples.length, activeRoutes.length * 9);
        for (const route of activeRoutes) {
          const samples = report.samples.filter(
            (sample: { route: string }) => sample.route === route,
          );
          assert.deepEqual(
            samples.map((sample: { iteration: number }) => sample.iteration),
            [0, 1, 2, 3, 4, 5, 6, 7, 8],
          );
          for (const sample of samples) {
            verify(sample.value, input);
            assert.equal(sample.warmup, sample.iteration < 2);
            assert.deepEqual(
              JSON.parse(
                await readFile(
                  join(
                    saved,
                    input.name,
                    `${report.mode}-${sample.iteration}-${route}-sample.json`,
                  ),
                  "utf8",
                ),
              ),
              sample,
            );
          }
        }
        assert.deepEqual(
          report.summaries,
          activeRoutes.map((route) => ({
            route,
            ...summarize(
              report.samples
                .filter(
                  (sample: { route: string; warmup: boolean }) =>
                    sample.route === route && !sample.warmup,
                )
                .map((sample: { milliseconds: number }) => sample.milliseconds),
            ),
          })),
        );
      }
      for (const route of routes) {
        const output = await runProcess(
          route,
          input,
          join(saved, input.name),
          join(directory, `${input.name}-${route}.json`),
          java,
          jar,
        );
        verify(output.value, input);
        replayed.push({ name: input.name, route, value: output.value });
      }
      for (const route of warmRoutes) {
        const value = await engines.run(route, input);
        verify(value, input);
        replayed.push({ name: input.name, route, mode: "reused", value });
      }
    }
  } finally {
    await engines.close();
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
    `${cases().length} models, ${replayed.length} checks reproduced; timing is not an independent sample`,
  );
} catch (error) {
  await writeFile(
    join(directory, "error.json"),
    JSON.stringify({ status: "error", message: String(error) }),
    { flag: "wx" },
  );
  throw error;
}
