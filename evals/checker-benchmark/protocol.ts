import assert from "node:assert/strict";
import { isRecord } from "../../src/trace.js";
import { benchmarkCases } from "../rust-safety/cases.js";

export interface Input {
  readonly name: string;
  readonly source: string;
  readonly config: string;
  readonly states: number;
  readonly generated: number;
}

export const bounds = {
  maxDepth: 2000000,
  maxStates: 2000000,
  maxWork: 20000000,
};
export const routes = [
  "tla-ts",
  "tlc",
  "modelt-wasm",
  "modelt-native",
] as const;
export type Route = (typeof routes)[number];
export const warmRoutes = ["tla-ts", "modelt-wasm", "modelt-native"] as const;
export type WarmRoute = (typeof warmRoutes)[number];

export const cases = (): readonly Input[] => {
  const existing = benchmarkCases(true);
  const ring = existing.find((input) => input.name === "ring-100000");
  assert.ok(ring);
  return [
    ...existing.map((input) => ({
      ...input,
      generated:
        input.name === "set-delivery-12" || input.name === "function-nodes-12"
          ? 49153
          : input.name === "sequence-queue-10"
            ? 3071
            : input.name.startsWith("grid-")
              ? input.states * 2 + 1
              : input.states + 1,
    })),
    {
      ...ring,
      name: "ring-1000000",
      states: 1000000,
      generated: 1000001,
      config: ring.config.replace("N = 100000", "N = 1000000"),
    },
  ];
};

export const verify = (
  value: unknown,
  expected: Pick<Input, "states" | "generated">,
) => {
  assert.ok(isRecord(value));
  assert.equal(value.status, "complete", JSON.stringify(value));
  assert.equal(value.violation, null);
  assert.equal(value.states, expected.states, "Distinct state count differs");
  assert.equal(
    value.generated,
    expected.generated,
    "Generated state count differs",
  );
  return { states: value.states, generated: value.generated };
};

export const summarize = (samples: readonly number[]) => {
  assert.ok(
    samples.length > 0 &&
      samples.every((value) => Number.isFinite(value) && value >= 0),
  );
  const sorted = [...samples].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median !== undefined);
  return { median, min: sorted[0], max: sorted[sorted.length - 1] };
};

export const order = <T>(
  values: readonly T[],
  iteration: number,
): readonly T[] => [
  ...values.slice(iteration % values.length),
  ...values.slice(0, iteration % values.length),
];
