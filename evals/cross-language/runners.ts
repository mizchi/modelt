import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  counterModel,
  isCounterAction,
} from "../../examples/durable-counter.js";
import { checkConformance, checkTrace } from "../../src/conformance.js";
import type {
  Driver,
  PortableResult,
  PortableValue,
} from "../../src/contracts.js";
import { checkFiniteHistory, createFiniteModel } from "../../src/finite.js";
import {
  fromPortableValue,
  toPortableTrace,
  toPortableValue,
} from "../../src/portable.js";
import { decodePortableResult } from "../../src/portable-wasm.js";
import { isRecord } from "../../src/trace.js";
import {
  type CounterFault,
  createFaultyCounter,
} from "../harness/counter-faults.js";
import { digest } from "../usable/provenance.js";
import { isFault, type OracleSuite, parseSuite } from "./suite.js";

interface Calls {
  readonly resets: number;
  readonly steps: number;
}
export interface Execution {
  readonly caseId: string;
  readonly fault: CounterFault;
  readonly finite: PortableResult;
  readonly replay: PortableResult;
  readonly finiteCalls: Calls;
  readonly replayCalls: Calls;
}

const action = (value: PortableValue) => {
  const decoded = fromPortableValue(value);
  assert.ok(isCounterAction(decoded), "Invalid counter action");
  return decoded;
};
const driver = (fault: CounterFault) => {
  const implementation = createFaultyCounter(fault);
  const calls = { resets: 0, steps: 0 };
  const portable: Driver<PortableValue, PortableValue> = {
    reset: async () => {
      calls.resets++;
      return toPortableValue(await implementation.reset());
    },
    step: async (value) => {
      calls.steps++;
      return toPortableValue(await implementation.step(action(value)));
    },
  };
  return { calls, portable };
};

const runTS = async (suite: OracleSuite): Promise<readonly Execution[]> => {
  const model = createFiniteModel(suite.model);
  const rows: Execution[] = [];
  for (const entry of suite.cases) {
    assert.equal(
      (await checkFiniteHistory(model, entry.oracle)).status,
      "matched",
      `Invalid oracle: ${entry.id}`,
    );
    for (const fault of suite.faults) {
      const finiteDriver = driver(fault);
      const finite = await checkConformance(
        model,
        finiteDriver.portable,
        entry.oracle.steps.map((step) => step.action),
      );
      const finiteResult: PortableResult = {
        ...finite,
        trace: { format: "modelt.portable-trace", ...finite.trace },
      };
      const replayDriver = driver(fault);
      const replay = await checkTrace(entry.oracle, replayDriver.portable);
      const replayResult: PortableResult = {
        ...replay,
        trace: { format: "modelt.portable-trace", ...replay.trace },
      };
      const reference = await checkConformance(
        counterModel,
        createFaultyCounter(fault),
        entry.oracle.steps.map((step) => action(step.action)),
      );
      assert.deepEqual(finiteResult, {
        ...reference,
        actual: toPortableValue(reference.actual),
        expected: reference.expected.map(toPortableValue),
        trace: toPortableTrace(reference.trace),
      });
      rows.push({
        caseId: entry.id,
        fault,
        finite: finiteResult,
        replay: replayResult,
        finiteCalls: { ...finiteDriver.calls },
        replayCalls: { ...replayDriver.calls },
      });
    }
  }
  return rows;
};

const parseExecutions = (bytes: Buffer): readonly Execution[] => {
  const input: unknown = JSON.parse(bytes.toString());
  assert.ok(Array.isArray(input), "Missing backend results");
  return input.map((entry: unknown) => {
    assert.ok(
      isRecord(entry) &&
        typeof entry.caseId === "string" &&
        isFault(entry.fault),
    );
    const calls = (value: unknown): Calls => {
      assert.ok(
        isRecord(value) &&
          typeof value.resets === "number" &&
          typeof value.steps === "number" &&
          Number.isSafeInteger(value.resets) &&
          Number.isSafeInteger(value.steps),
      );
      return { resets: value.resets, steps: value.steps };
    };
    return {
      caseId: entry.caseId,
      fault: entry.fault,
      finite: decodePortableResult(entry.finite),
      replay: decodePortableResult(entry.replay),
      finiteCalls: calls(entry.finiteCalls),
      replayCalls: calls(entry.replayCalls),
    };
  });
};

export const executeSuite = async (input: OracleSuite) => {
  const suite = parseSuite(input);
  // Validate every oracle before any backend starts executing SUT operations.
  const model = createFiniteModel(suite.model);
  for (const entry of suite.cases)
    assert.equal(
      (await checkFiniteHistory(model, entry.oracle)).status,
      "matched",
      `Invalid oracle: ${entry.id}`,
    );
  const ts = await runTS(suite);
  const bytes = JSON.stringify(suite);
  const options = { input: bytes, maxBuffer: 64 * 1024 * 1024 };
  const rust = parseExecutions(
    execFileSync(
      "evals/shared-oracle-rust/target/release/modelt-shared-oracle",
      [],
      options,
    ),
  );
  const go = parseExecutions(
    execFileSync(
      ".artifacts/go/counter-replay",
      [
        "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm",
      ],
      options,
    ),
  );
  assert.equal(ts.length, suite.cases.length * suite.faults.length);
  for (const rows of [ts, rust, go]) {
    assert.equal(rows.length, ts.length, "Missing backend executions");
    for (const [index, row] of rows.entries()) {
      assert.deepEqual(
        row,
        ts[index],
        `Backend differs at ${row.caseId}/${row.fault}`,
      );
      assert.deepEqual(
        row.finite,
        row.replay,
        `Oracle replay differs at ${row.caseId}/${row.fault}`,
      );
      assert.notEqual(
        row.finite.status,
        "invalid",
        "An enabled corpus became invalid",
      );
      assert.deepEqual(row.finiteCalls, {
        resets: 1,
        steps: row.finite.checkedSteps,
      });
      assert.deepEqual(row.replayCalls, row.finiteCalls);
      if (row.fault === "none")
        assert.equal(
          row.finite.status,
          "matched",
          `Normal control failed at ${row.caseId}`,
        );
    }
  }
  return {
    languages: 3,
    normalControls: suite.cases.length * 3 * 2,
    comparisons: ts.length * 2 * 2,
    backendDigests: {
      ts: digest(JSON.stringify(ts)),
      rust: digest(JSON.stringify(rust)),
      go: digest(JSON.stringify(go)),
    },
    rows: ts.map((row) => ({
      caseId: row.caseId,
      fault: row.fault,
      result: row.finite,
      calls: row.finiteCalls,
    })),
  };
};
