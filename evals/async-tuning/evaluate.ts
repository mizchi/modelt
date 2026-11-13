import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type CounterAction,
  counterModel,
} from "../../examples/counter-model.js";
import { checkConformance } from "../../src/conformance.js";
import type { PortableResult } from "../../src/contracts.js";
import { compileFiniteModel } from "../../src/finite.js";
import { toPortableTrace, toPortableValue } from "../../src/portable.js";
import { executeSuite } from "../cross-language/runners.js";
import {
  type CounterFault,
  counterFaults,
  createFaultyCounter,
} from "../harness/counter-faults.js";
import { type Corpus, generateCorpus } from "../harness/search.js";
import { digest } from "../usable/provenance.js";
import { benchmark } from "./benchmark.js";
import { generateFeedbackCorpus } from "./feedback.js";
import {
  compareHistories,
  liveHistories,
  uncertainHistories,
} from "./histories.js";
import { createOracle } from "./oracle.js";
import { runPatterns } from "./patterns.js";
import { fingerprint } from "./provenance.js";
import { shrinkComparison } from "./shrink.js";

interface Witness {
  readonly seed: number;
  readonly method: string;
  readonly fault: CounterFault;
  readonly actions: readonly CounterAction[];
  readonly result: PortableResult;
}
interface CorpusRecord extends Corpus<CounterAction> {
  readonly seed: number;
  readonly method: string;
  readonly generationMs: number;
  readonly features?: number;
  readonly featureCalls?: number;
}
interface Trial {
  readonly seed: number;
  readonly method: string;
  readonly fault: CounterFault;
  readonly detected: boolean;
  readonly firstOperation: number | null;
  readonly firstMs: number | null;
  readonly operations: number;
  readonly cases: number;
  readonly invalid: number;
  readonly elapsedMs: number;
  readonly cpuMs: number;
}
const phase = process.argv[2];
assert.ok(
  phase === "development" || phase === "confirmation" || phase === "regression",
);
const directory = process.argv[3];
assert.ok(directory, "Pass a new run directory");
const sources = await fingerprint();
const seeds =
  phase === "development"
    ? [231, 232, 233, 234, 235]
    : Array.from({ length: 20 }, (_, index) => 241 + index);
const parent = process.argv[4];
if (phase === "confirmation") {
  assert.ok(parent, "Confirmation requires the completed development run");
  const previous = JSON.parse(
    await readFile(join(parent, "result.json"), "utf8"),
  );
  assert.equal(previous.status, "complete");
  assert.equal(previous.phase, "development");
  assert.equal(
    previous.sourceVersion,
    sources.sourceVersion,
    "Sources changed since development",
  );
}
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const write = (name: string, value: unknown) =>
  writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const ledger = async (value: unknown) => {
  if (directory.startsWith("evals/runs/"))
    await appendFile("evals/runs/ledger.jsonl", `${JSON.stringify(value)}\n`);
};
const wasm = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
await write("manifest.json", {
  plan: "0008-async-tuning",
  phase,
  seeds,
  parent: parent || null,
  ...sources,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean),
  node: process.version,
  go: execFileSync("go", ["version"]).toString().trim(),
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  platform: process.platform,
  arch: process.arch,
  wasmBytes: wasm.length,
  wasmSha256: digest(wasm),
  startedAt: new Date().toISOString(),
});
try {
  const patterns = await runPatterns();
  await compareHistories(
    patterns.creditModel,
    patterns.crash.map((entry) => ({ history: entry.history, maxNodes: 100 })),
  );
  const live = await liveHistories();
  const uncertain = await uncertainHistories();
  await write("histories.json", { live, uncertain });
  await write("patterns.json", patterns);
  const corpora: CorpusRecord[] = [];
  const trials: Trial[] = [];
  const witnesses: Witness[] = [];
  for (const seed of seeds)
    for (const method of seed % 2 === 0
      ? (["alternating", "feedback"] as const)
      : (["feedback", "alternating"] as const)) {
      const generated = performance.now();
      const corpus =
        method === "feedback"
          ? generateFeedbackCorpus({ seed, maxOperations: 512, maxDepth: 16 })
          : generateCorpus(counterModel, "alternating", {
              seed,
              maxOperations: 512,
              maxDepth: 16,
            });
      const generationMs = performance.now() - generated;
      corpora.push({ seed, method, ...corpus, generationMs });
      for (const fault of ["none", ...counterFaults] as const) {
        const started = performance.now();
        const cpu = process.cpuUsage();
        let operations = 0;
        let invalid = 0;
        let firstOperation: number | null = null;
        let firstMs: number | null = null;
        for (const actions of corpus.cases) {
          const result = await checkConformance(
            counterModel,
            createFaultyCounter(fault),
            actions,
          );
          operations += 1 + result.checkedSteps;
          if (result.status === "invalid") invalid++;
          if (fault === "none") assert.equal(result.status, "matched");
          if (result.status === "mismatch" && firstOperation === null) {
            firstOperation = operations;
            firstMs = performance.now() - started;
            witnesses.push({
              seed,
              method,
              fault,
              actions,
              result: {
                ...result,
                actual: toPortableValue(result.actual),
                expected: result.expected.map(toPortableValue),
                trace: toPortableTrace(result.trace),
              },
            });
          }
        }
        assert.equal(invalid, 0);
        const used = process.cpuUsage(cpu);
        trials.push({
          seed,
          method,
          fault,
          detected: firstOperation !== null,
          firstOperation,
          firstMs,
          operations,
          cases: corpus.cases.length,
          invalid,
          elapsedMs: performance.now() - started,
          cpuMs: (used.user + used.system) / 1000,
        });
      }
    }
  await write("corpora.json", corpora);
  await write("trials.json", trials);
  await write("witnesses.json", witnesses);
  const finite = compileFiniteModel(counterModel, {
    maxDepth: 20,
    maxStates: 1000,
  });
  assert.ok(finite.model);
  // Reproduce one saved witness per known fault through all three live implementations.
  const selected = counterFaults
    .map((fault) => {
      const witness = witnesses.find((entry) => entry.fault === fault);
      return witness
        ? {
            id: fault,
            seed: witness.seed,
            oracle: createOracle(counterModel, witness.actions),
          }
        : undefined;
    })
    .filter((entry) => entry !== undefined);
  assert.ok(selected.length > 0);
  const replaySuite = {
    format: "modelt.oracle-suite",
    version: 1,
    model: finite.model,
    faults: ["none", ...counterFaults],
    cases: selected,
  } as const;
  await write("replay-suite.json", replaySuite);
  const replay = await executeSuite(replaySuite);
  for (const entry of selected)
    assert.equal(
      replay.rows.find(
        (row) => row.caseId === entry.id && row.fault === entry.id,
      )?.result.status,
      "mismatch",
    );
  const shrink = await shrinkComparison();
  await write("shrink.json", shrink);
  const timings = await benchmark();
  await write("benchmark.json", timings);
  const files = await Promise.all(
    [
      "manifest.json",
      "histories.json",
      "patterns.json",
      "corpora.json",
      "trials.json",
      "witnesses.json",
      "replay-suite.json",
      "shrink.json",
      "benchmark.json",
    ].map(async (path) => ({
      path,
      sha256: digest(await readFile(join(directory, path))),
    })),
  );
  const summary = ["alternating", "feedback"].map((method) => ({
    method,
    generationMs: corpora
      .filter((entry) => entry.method === method)
      .reduce((total, entry) => total + entry.generationMs, 0),
    normalCases: trials
      .filter((entry) => entry.method === method && entry.fault === "none")
      .reduce((total, entry) => total + entry.cases, 0),
    faults: counterFaults.map((fault) => ({
      fault,
      detectedSeeds: trials.filter(
        (entry) =>
          entry.method === method && entry.fault === fault && entry.detected,
      ).length,
      seeds: seeds.length,
    })),
  }));
  const result = {
    status: "complete",
    phase,
    sourceVersion: sources.sourceVersion,
    summary,
    witnesses: witnesses.length,
    replayedFaults: selected.length,
    concurrentHistories:
      live.cases.length + uncertain.cases.length + patterns.crash.length,
    concurrentComparisons:
      (live.cases.length + uncertain.cases.length + patterns.crash.length) * 3,
    files,
  };
  await write("result.json", result);
  await ledger({
    runId: directory.split("/").at(-1),
    kind: "async-tuning",
    phase,
    status: "complete",
    sourceVersion: sources.sourceVersion,
    plan: "0008-async-tuning",
  });
  console.log(JSON.stringify({ ...result, files: undefined }));
} catch (error) {
  await write("error.json", { message: String(error) });
  await ledger({
    runId: directory.split("/").at(-1),
    kind: "async-tuning",
    phase,
    status: "error",
    message: String(error),
    sourceVersion: sources.sourceVersion,
  });
  throw error;
}
