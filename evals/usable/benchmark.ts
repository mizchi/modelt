import assert from "node:assert/strict";
import type {
  FiniteModel,
  PortableCore,
  PortableResult,
  PortableTrace,
} from "../../src/contracts.js";
import {
  checkFiniteHistory,
  createFiniteModel,
  parseFiniteModel,
} from "../../src/finite.js";
import { checkFiniteHistories } from "../../src/portable.js";
import { parsePortableTrace } from "../../src/portable-value.js";
import { decodePortableResult } from "../../src/portable-wasm.js";
import { isRecord } from "../../src/trace.js";
import { startNative } from "./native.js";

const decodeResults = (value: unknown): readonly PortableResult[] => {
  assert.ok(
    isRecord(value) &&
      value.kind === "results" &&
      Array.isArray(value.results) &&
      Object.keys(value).length === 2,
  );
  return value.results.map((result: unknown) => decodePortableResult(result));
};
const median = (values: readonly number[]) =>
  [...values].sort((left, right) => left - right)[
    Math.floor(values.length / 2)
  ];

export const benchmarkFinite = async (
  artifact: FiniteModel,
  source: readonly PortableTrace[],
  core: PortableCore,
) => {
  const setup = performance.now();
  const model = createFiniteModel(artifact);
  const tsSetupMs = performance.now() - setup;
  const start = performance.now();
  const native = startNative();
  await native.request({
    version: 1,
    request: { kind: "canonicalize", value: { type: "null" } },
  });
  const nativeStartupMs = performance.now() - start;
  const batches = [];
  try {
    const controls = await Promise.all(
      source.map((trace) => checkFiniteHistory(model, trace)),
    );
    assert.deepEqual(checkFiniteHistories(core, artifact, source), controls);
    assert.deepEqual(
      decodeResults(
        await native.request({
          version: 1,
          request: { kind: "check-finite", model: artifact, traces: source },
        }),
      ),
      controls,
    );
    for (const size of [1, 16, 64]) {
      const traces = Array.from({ length: size }, () => {
        const trace = source[0];
        if (!trace) throw new Error("Missing benchmark history");
        return trace;
      });
      const command = {
        version: 1 as const,
        request: { kind: "check-finite" as const, model: artifact, traces },
      };
      const expected = await Promise.all(
        traces.map((trace) => checkFiniteHistory(model, trace)),
      );
      const targets = [
        {
          name: "ts-prepared",
          run: async () =>
            Promise.all(
              traces.map((trace) => checkFiniteHistory(model, trace)),
            ),
        },
        {
          name: "ts-wire",
          run: async () => {
            const input: unknown = JSON.parse(JSON.stringify(command));
            assert.ok(
              isRecord(input) &&
                isRecord(input.request) &&
                Array.isArray(input.request.traces),
            );
            const restored = createFiniteModel(
              parseFiniteModel(input.request.model),
            );
            const results = await Promise.all(
              input.request.traces.map((trace: unknown) =>
                checkFiniteHistory(restored, parsePortableTrace(trace)),
              ),
            );
            return decodeResults(
              JSON.parse(JSON.stringify({ kind: "results", results })),
            );
          },
        },
        {
          name: "wasm-wire",
          run: async () => checkFiniteHistories(core, artifact, traces),
        },
        {
          name: "native-jsonl",
          run: async () => decodeResults(await native.request(command)),
        },
      ];
      const samples = new Map(
        targets.map((target) => [target.name, [] as number[]]),
      );
      for (let batch = 0; batch < 12; batch++) {
        for (const target of batch % 2 === 0 ? targets : targets.toReversed()) {
          const before = performance.now();
          const results = await target.run();
          const elapsed = performance.now() - before;
          assert.deepEqual(
            results,
            expected,
            `${target.name} verdict or trace differs`,
          );
          if (batch >= 3) samples.get(target.name)?.push(elapsed);
        }
      }
      batches.push({
        size,
        inputBytes: Buffer.byteLength(JSON.stringify(command)),
        targets: [...samples].map(([name, values]) => ({
          name,
          samplesMs: values,
          medianMs: median(values),
          perHistoryMs: (median(values) ?? 0) / size,
        })),
      });
    }
  } finally {
    await native.close();
  }
  return {
    warmupBatches: 3,
    measuredBatches: 9,
    profiledHistory: source[0],
    correctnessControls: source.length,
    tsSetupMs,
    nativeStartupMs,
    batches,
    scope:
      "Every batch size repeats the same first history. Other histories are correctness controls outside timing. Recording disabled. ts-prepared excludes loading; wire profiles include JSON/model loading, validation and full results. Native uses one persistent process; IPC is included and process startup is separate. Wall times are use costs, not CPU language ratios.",
  };
};
