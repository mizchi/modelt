import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { checkConformance } from "../../src/conformance.js";
import type { PortableResult, PortableTrace } from "../../src/contracts.js";
import {
  checkFiniteHistory,
  compileFiniteModel,
  createFiniteModel,
} from "../../src/finite.js";
import { createSimulationHost } from "../../src/host.js";
import {
  checkFiniteHistories,
  coreDeletionCandidates,
  createPortableWasm,
  toPortableTrace,
  toPortableValue,
  verifyHostTape,
} from "../../src/portable.js";
import { decodePortableResult } from "../../src/portable-wasm.js";
import { shrinkCounterexample } from "../../src/shrink.js";
import { isRecord } from "../../src/trace.js";
import { generateCorpus } from "../harness/search.js";
import { benchmarkFinite } from "./benchmark.js";
import {
  createMutexDriver,
  loadMutex,
  type MutexAction,
  mutexModel,
  mutexRegression,
} from "./mutex.js";
import { startNative } from "./native.js";
import { digest, usableFingerprint } from "./provenance.js";
import { exerciseHost } from "./scenario.js";

interface Witness {
  readonly seed: number;
  readonly actions: readonly MutexAction[];
  readonly result: PortableResult;
  readonly originalLength: number;
  readonly checks: number;
  readonly sutOperations: number;
  readonly invalidCandidates: number;
}
const directory = process.argv[2] ?? `evals/runs/0005-usable-${Date.now()}`;
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const write = (name: string, value: unknown) =>
  writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const fingerprint = await usableFingerprint();
const wasmBytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
await write("manifest.json", {
  version: 1,
  plan: "0005-usable-core",
  ...fingerprint,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean),
  node: process.version,
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  platform: process.platform,
  arch: process.arch,
  startedAt: new Date().toISOString(),
  upstream: JSON.parse(
    await readFile("evals/fixtures/async-mutex/provenance.json", "utf8"),
  ),
  wasmBytes: wasmBytes.length,
  wasmSha256: digest(wasmBytes),
  seeds: Array.from({ length: 20 }, (_, index) => 161 + index),
  maxOperations: 256,
  maxDepth: 10,
});
const started = performance.now();
const native = startNative();
try {
  const before = await loadMutex("before");
  const after = await loadMutex("after");
  const startup = performance.now();
  const core = await createPortableWasm(wasmBytes);
  const wasmStartupMs = performance.now() - startup;
  const compiled = compileFiniteModel(mutexModel, {
    maxDepth: 20,
    maxStates: 2000,
  });
  assert.equal(compiled.status, "complete");
  assert.ok(compiled.model);
  const artifact = compiled.model;
  const model = createFiniteModel(artifact);
  await write("model.json", artifact);
  const regression = await checkConformance(
    mutexModel,
    createMutexDriver(before),
    mutexRegression,
  );
  assert.equal(regression.status, "mismatch");
  assert.equal(
    (
      await checkConformance(
        mutexModel,
        createMutexDriver(after),
        mutexRegression,
      )
    ).status,
    "matched",
  );
  const rows = [];
  const witnesses: Witness[] = [];
  let normalControls = 0;
  let detectedSeeds = 0;
  let nativeReplies = 0;
  for (let seed = 161; seed <= 180; seed++) {
    const corpus = generateCorpus(mutexModel, "alternating", {
      seed,
      maxOperations: 256,
      maxDepth: 10,
    });
    const histories: PortableTrace[] = [];
    const expected: PortableResult[] = [];
    let first:
      | { actions: readonly MutexAction[]; result: PortableResult }
      | undefined;
    for (const [index, actions] of corpus.cases.entries()) {
      const fixed = await checkConformance(
        mutexModel,
        createMutexDriver(after),
        actions,
      );
      assert.equal(fixed.status, "matched");
      normalControls++;
      for (const factory of [before, after]) {
        const reference = await checkConformance(
          mutexModel,
          createMutexDriver(factory),
          actions,
        );
        assert.notEqual(reference.status, "invalid");
        const trace = toPortableTrace(reference.trace);
        histories.push(trace);
        const restored = await checkFiniteHistory(model, trace);
        assert.deepEqual(restored, {
          ...reference,
          actual: toPortableValue(reference.actual),
          expected: reference.expected.map(toPortableValue),
          trace,
        });
        expected.push(restored);
        if (factory === before && restored.status === "mismatch" && !first)
          first = {
            actions: reference.trace.steps.map((step) => step.action),
            result: restored,
          };
        rows.push({
          seed,
          case: index,
          revision: factory === before ? "before" : "after",
          actions,
          status: restored.status,
          checkedSteps: restored.checkedSteps,
          traceSha256: digest(JSON.stringify(trace)),
        });
      }
    }
    const actual = checkFiniteHistories(core, artifact, histories);
    assert.equal(actual.length, expected.length);
    for (const [index, result] of actual.entries())
      assert.deepEqual(result, expected[index], `Wasm case ${index} differs`);
    const reply = await native.request({
      version: 1,
      request: { kind: "check-finite", model: artifact, traces: histories },
    });
    assert.ok(
      isRecord(reply) &&
        reply.kind === "results" &&
        Array.isArray(reply.results),
    );
    assert.equal(reply.results.length, expected.length);
    for (const [index, result] of reply.results.entries())
      assert.deepEqual(
        decodePortableResult(result),
        expected[index],
        `Native case ${index} differs`,
      );
    nativeReplies += expected.length;
    if (first) {
      detectedSeeds++;
      let operations = 0;
      let invalid = 0;
      const evaluate = async (actions: readonly MutexAction[]) => {
        const result = await checkConformance(
          mutexModel,
          createMutexDriver(before),
          actions,
        );
        operations += result.checkedSteps + 1;
        if (result.status === "invalid") invalid++;
        return result.status === "mismatch"
          ? { status: "mismatch" as const, signature: "stranded-mutex" }
          : { status: result.status };
      };
      const reference = await shrinkCounterexample(first.actions, evaluate, {
        maxChecks: 128,
      });
      operations = 0;
      invalid = 0;
      const shrunk = await shrinkCounterexample(first.actions, evaluate, {
        maxChecks: 128,
        candidates: (length) => coreDeletionCandidates(core, length),
      });
      assert.deepEqual(shrunk, reference);
      const result = await checkConformance(
        mutexModel,
        createMutexDriver(before),
        shrunk.actions,
      );
      assert.equal(result.status, "mismatch");
      assert.equal(
        (
          await checkConformance(
            mutexModel,
            createMutexDriver(after),
            shrunk.actions,
          )
        ).status,
        "matched",
      );
      witnesses.push({
        seed,
        actions: shrunk.actions,
        originalLength: first.actions.length,
        checks: shrunk.checks,
        sutOperations: operations,
        invalidCandidates: invalid,
        result: {
          ...result,
          actual: toPortableValue(result.actual),
          expected: result.expected.map(toPortableValue),
          trace: toPortableTrace(result.trace),
        },
      });
    }
    console.log(
      `seed ${seed}: ${corpus.cases.length} before/after cases matched across TS/Wasm/native; detected ${Boolean(first)}`,
    );
  }
  assert.ok(witnesses.length > 0, "No historical bug was detected");
  const normal = await checkConformance(
    mutexModel,
    createMutexDriver(after),
    mutexRegression,
  );
  const history = toPortableTrace(normal.trace);
  const benchmark = await benchmarkFinite(
    artifact,
    [
      history,
      toPortableTrace(regression.trace),
      {
        ...history,
        steps: [
          {
            action: toPortableValue({ type: "unknown" }),
            observation: toPortableValue(null),
          },
        ],
      },
    ],
    core,
  );
  await write("benchmark.json", { ...benchmark, wasmStartupMs });
  const host = createSimulationHost({ seed: 3 });
  const snapshot = exerciseHost(host);
  const tape = host.trace();
  assert.deepEqual(
    exerciseHost(createSimulationHost({ replay: tape })),
    snapshot,
  );
  const divergent = createSimulationHost({ replay: tape });
  assert.throws(() => divergent.advance(1));
  assert.throws(() => divergent.finish());
  assert.equal(snapshot.durable, 1);
  const expectedHost = toPortableValue({
    clock: 10,
    running: true,
    storage: { counter: 1 },
    pending: [],
  });
  assert.deepEqual(verifyHostTape(core, tape), expectedHost);
  const nativeHost = await native.request({
    version: 1,
    request: { kind: "replay-host", tape },
  });
  assert.ok(isRecord(nativeHost) && nativeHost.kind === "host");
  assert.deepEqual(nativeHost.snapshot, expectedHost);
  await write("host.json", { tape, snapshot });
  const packages = JSON.parse(
    await readFile(".artifacts/packages/consumer-result.json", "utf8"),
  );
  assert.equal(packages.status, "complete");
  await write("packages.json", packages);
  assert.equal(
    (await usableFingerprint()).sourceVersion,
    fingerprint.sourceVersion,
  );
  await write("cases.json", rows);
  await write("witnesses.json", witnesses);
  const result = {
    status: "complete",
    semanticMismatches: 0,
    normalControls,
    comparisons: rows.length,
    nativeResults: nativeReplies,
    detectedSeeds,
    totalSeeds: 20,
    replayedWitnesses: witnesses.length,
    shrink: witnesses.map((witness) => ({
      seed: witness.seed,
      before: witness.originalLength,
      after: witness.actions.length,
      checks: witness.checks,
      sutOperations: witness.sutOperations,
      invalidCandidates: witness.invalidCandidates,
    })),
    finite: { states: artifact.states.length, edges: compiled.edges },
    hostReplay: "matched",
    packageConsumers: "matched",
    elapsedMs: performance.now() - started,
    authoringMinutes: null,
    authoringNote:
      "Model/Driver authoring was interleaved with framework work, so no isolated human-time estimate is claimed.",
    scope:
      "Reproduction of a known archived upstream bug, not discovery of an unknown bug or a liveness proof. CI repeats are regression checks.",
  };
  await write("result.json", result);
  console.log(JSON.stringify(result));
} catch (error) {
  await write("result.json", {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
} finally {
  await native.close();
}
