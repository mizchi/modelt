import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { check } from "tla-ts";
import type {
  SafetyBounds,
  SafetyProgram,
  SafetyResult,
} from "../../src/contracts.js";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety, decodeSafetyResult } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import { digest } from "../usable/provenance.js";
import { benchmarkCases } from "./cases.js";
import { fingerprint } from "./provenance.js";

interface Sample {
  readonly route: string;
  readonly milliseconds: number;
  readonly result: {
    readonly status: string;
    readonly states: number;
    readonly generated: number;
  };
}
interface Report {
  readonly name: string;
  readonly input: {
    readonly name: string;
    readonly source: string;
    readonly config: string;
    readonly states: number;
  };
  readonly program: ReturnType<typeof compileTlaSafety>;
  readonly samples: readonly Sample[];
  readonly medians: readonly {
    readonly route: string;
    readonly milliseconds: number;
  }[];
}

const runNative = (
  program: SafetyProgram,
  bounds: SafetyBounds,
): SafetyResult => {
  const output: unknown = JSON.parse(
    execFileSync("crates/modelt-core/target/release/modelt-core", {
      input: JSON.stringify({
        version: 1,
        request: { kind: "check-safety", program, bounds },
      }),
      maxBuffer: 16 * 1024 * 1024,
    }).toString(),
  );
  assert.ok(
    isRecord(output) && output.kind === "safety",
    JSON.stringify(output),
  );
  return decodeSafetyResult(output.result);
};

const directory = process.argv[2];
assert.ok(directory, "Pass a new output directory");
await mkdir(dirname(directory), { recursive: true });
await mkdir(directory, { recursive: false });
const write = (name: string, value: unknown) =>
  writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
  });
const bytes = await readFile(
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
);
const source = await fingerprint();
const started = performance.now();
const core = await createPortableWasm(bytes);
const startupMs = performance.now() - started;
await write("manifest.json", {
  plan: "0009-rust-safety",
  ...source,
  commit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
  dirtyPaths: execFileSync("git", ["status", "--short"]).toString().trim(),
  startedAt: new Date().toISOString(),
  node: process.version,
  rust: execFileSync("rustc", ["--version"]).toString().trim(),
  platform: process.platform,
  arch: process.arch,
  wasmSha256: digest(bytes),
  wasmBytes: bytes.length,
  startupMs,
  warmup: 2,
  measurements: 7,
});
const reports: Report[] = [];
try {
  for (const input of benchmarkCases()) {
    const program = compileTlaSafety(input);
    const bounds = { maxDepth: 1000000, maxStates: 1000000, maxWork: 10000000 };
    const samples: Sample[] = [];
    const run = async (route: string): Promise<Sample> => {
      const start = performance.now();
      if (route === "frontend") {
        const compiled = compileTlaSafety(input);
        const milliseconds = performance.now() - start;
        assert.deepEqual(compiled, program);
        return {
          route,
          milliseconds,
          result: { status: "compiled", states: 0, generated: 0 },
        };
      }
      if (route === "tla-ts") {
        const result = await check({
          source: input.source,
          config: input.config,
          workers: 1,
        });
        const milliseconds = performance.now() - start;
        assert.equal(result.status, "success");
        return {
          route,
          milliseconds,
          result: {
            status: "complete",
            states: result.distinctStates,
            generated: result.generatedStates,
          },
        };
      }
      const result =
        route === "wasm"
          ? checkSafety(core, program, bounds)
          : runNative(program, bounds);
      const milliseconds = performance.now() - start;
      assert.equal(result.status, "complete");
      assert.equal(result.violation, null);
      return {
        route,
        milliseconds,
        result: {
          status: result.status,
          states: result.states,
          generated: result.generated,
        },
      };
    };
    for (let repeat = 0; repeat < 9; repeat++) {
      const routes =
        repeat % 2 === 0
          ? ["frontend", "tla-ts", "native-process", "wasm"]
          : ["wasm", "native-process", "tla-ts", "frontend"];
      const iteration = [];
      for (const route of routes) iteration.push(await run(route));
      const expected = iteration.find((sample) => sample.route === "tla-ts");
      assert.ok(expected);
      assert.equal(expected.result.states, input.states);
      for (const sample of iteration.filter(
        (sample) => sample.route !== "frontend",
      ))
        assert.deepEqual(
          sample.result,
          expected.result,
          `${input.name}: ${sample.route}`,
        );
      if (repeat >= 2) samples.push(...iteration);
    }
    const medians = ["frontend", "tla-ts", "native-process", "wasm"].map(
      (route) => {
        const sorted = samples
          .filter((sample) => sample.route === route)
          .map((sample) => sample.milliseconds)
          .sort((left, right) => left - right);
        const median = sorted[3];
        assert.ok(median !== undefined);
        return { route, milliseconds: median };
      },
    );
    reports.push({ name: input.name, input, program, samples, medians });
    console.log(JSON.stringify({ name: input.name, medians }));
  }
  await write("benchmark.json", reports);
  const files = await Promise.all(
    ["manifest.json", "benchmark.json"].map(async (path) => ({
      path,
      sha256: digest(await readFile(join(directory, path))),
    })),
  );
  await write("result.json", {
    status: "complete",
    plan: "0009-rust-safety",
    sourceVersion: source.sourceVersion,
    files,
    cases: reports.length,
    samples: reports.reduce((sum, report) => sum + report.samples.length, 0),
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "rust-safety", status: "complete", sourceVersion: source.sourceVersion, plan: "0009-rust-safety" })}\n`,
  );
} catch (error) {
  await write("error.json", {
    status: "error",
    message: String(error),
    completed: reports,
  });
  await appendFile(
    "evals/runs/ledger.jsonl",
    `${JSON.stringify({ runId: basename(directory), kind: "rust-safety", status: "error", sourceVersion: source.sourceVersion, plan: "0009-rust-safety" })}\n`,
  );
  throw error;
}
