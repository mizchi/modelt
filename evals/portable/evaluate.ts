import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CounterAction } from "../../examples/counter-model.js";
import { counterModel } from "../../examples/counter-model.js";
import { isCounterAction } from "../../examples/durable-counter.js";
import { checkConformance, checkTrace } from "../../src/conformance.js";
import type {
  PortableCommand,
  PortableCore,
  PortableOutput,
  PortableResult,
} from "../../src/contracts.js";
import {
  checkPortableConformance,
  checkPortableTrace,
  createPortableWasm,
  fromPortableValue,
  toPortableTrace,
  toPortableValue,
} from "../../src/portable.js";
import {
  counterFaults,
  createFaultyCounter,
} from "../harness/counter-faults.js";
import { generateCorpus } from "../harness/search.js";
import { digest, portableFingerprint } from "./provenance.js";
import { createNativeComparison } from "./transcript.js";

interface Witness {
  readonly seed: number;
  readonly fault: (typeof counterFaults)[number];
  readonly actions: readonly CounterAction[];
  readonly result: PortableResult;
}
const target = process.argv[2] ?? `evals/runs/0004-portable-${Date.now()}`;
await mkdir(dirname(target), { recursive: true });
await mkdir(target, { recursive: false });
const write = (name: string, value: unknown) =>
  writeFile(join(target, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const fingerprint = await portableFingerprint();
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
await write("manifest.json", {
  version: 1,
  plan: "0004-portable-core",
  split: "confirmation",
  ...fingerprint,
  node: process.version,
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean),
  platform: process.platform,
  arch: process.arch,
  wasmSha256: digest(bytes),
  wasmBytes: bytes.length,
  startedAt: new Date().toISOString(),
  seeds: Array.from({ length: 20 }, (_, index) => 121 + index),
  maxOperations: 512,
  maxDepth: 16,
});
const started = performance.now();
try {
  const initialization = performance.now();
  const wasm = await createPortableWasm(bytes);
  let startupMs = performance.now() - initialization;
  const witnesses = new Map<string, Witness>();
  const rows: {
    seed: number;
    case: number;
    fault: string;
    status: string;
    checkedSteps: number;
    traceSha256: string;
  }[] = [];
  let referenceMs = 0;
  let tsHostWasmMs = 0;
  let nativeTranscriptMs = 0;
  let wireReplies = 0;
  let normalControls = 0;
  for (let seed = 121; seed <= 140; seed++) {
    const comparison = await createNativeComparison(bytes);
    startupMs += comparison.startupMs;
    const core = comparison.core;
    const corpus = generateCorpus(counterModel, "alternating", {
      seed,
      maxOperations: 512,
      maxDepth: 16,
    });
    for (const [index, actions] of corpus.cases.entries()) {
      for (const fault of ["none", ...counterFaults] as const) {
        const beforeReference = performance.now();
        const reference = await checkConformance(
          counterModel,
          createFaultyCounter(fault),
          actions,
        );
        referenceMs += performance.now() - beforeReference;
        const beforeWasm = performance.now();
        const actual = await checkPortableConformance(
          core,
          counterModel,
          createFaultyCounter(fault),
          actions,
        );
        tsHostWasmMs += performance.now() - beforeWasm;
        assert.deepEqual(actual, {
          ...reference,
          actual: toPortableValue(reference.actual),
          expected: reference.expected.map(toPortableValue),
          trace: toPortableTrace(reference.trace),
        });
        assert.notEqual(actual.status, "invalid");
        if (fault === "none") {
          assert.equal(actual.status, "matched");
          normalControls++;
        }
        if (
          fault !== "none" &&
          actual.status === "mismatch" &&
          !witnesses.has(fault)
        )
          witnesses.set(fault, { seed, fault, actions, result: actual });
        rows.push({
          seed,
          case: index,
          fault,
          status: actual.status,
          checkedSteps: actual.checkedSteps,
          traceSha256: digest(JSON.stringify(actual.trace)),
        });
      }
    }
    const native = comparison.verify();
    nativeTranscriptMs += native.elapsedMs;
    wireReplies += native.replies;
    console.log(
      `seed ${seed}: ${corpus.cases.length} cases × 6 variants; ${native.replies} native/Wasm replies matched`,
    );
  }
  assert.deepEqual([...witnesses.keys()].sort(), [...counterFaults].sort());
  for (const witness of witnesses.values()) {
    const oracle = await checkConformance(
      counterModel,
      createFaultyCounter("none"),
      witness.actions,
    );
    const reference = await checkTrace(
      oracle.trace,
      createFaultyCounter(witness.fault),
    );
    const actual = await checkPortableTrace(
      wasm,
      toPortableTrace(oracle.trace),
      createFaultyCounter(witness.fault),
      (value) => {
        const action = fromPortableValue(value);
        if (!isCounterAction(action)) throw new Error("Invalid saved action");
        return action;
      },
    );
    assert.equal(actual.status, reference.status);
    assert.equal(actual.status, "mismatch");
  }
  assert.equal(
    (await portableFingerprint()).sourceVersion,
    fingerprint.sourceVersion,
  );
  await write("cases.json", rows);
  await write("witnesses.json", [...witnesses.values()]);
  const result = {
    status: "complete",
    semanticMismatches: 0,
    normalControls,
    comparisons: rows.length,
    wireReplies,
    detectedFaults: [...witnesses.keys()],
    savedOracleReplays: witnesses.size,
    timings: {
      elapsedMs: performance.now() - started,
      wasmStartupMs: startupMs,
      originalTsMs: referenceMs,
      instrumentedTsHostWasmMs: tsHostWasmMs,
      nativeTranscriptMs,
    },
    scope:
      "Synthetic finite counter. Native replays host responses; Rust example separately tests a native model and SUT. Timings include different instrumentation and are not a language speed comparison.",
  };
  await write("result.json", result);
  console.log(JSON.stringify(result));
} catch (error) {
  await write("result.json", {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  });
  throw error;
}
