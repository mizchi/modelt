import assert from "node:assert/strict";
import { createFaultyCounter } from "../evals/harness/counter-faults.js";
import {
  checkHistory,
  incrementHistoryModel,
} from "../evals/harness/history.js";
import { runScheduledCounter } from "../evals/harness/scheduled-counter.js";
import { enabledActions, generateCorpus } from "../evals/harness/search.js";
import { createTtlDriver, ttlModel } from "../evals/harness/ttl.js";
import { counterModel, createCounter } from "../examples/durable-counter.js";
import { checkConformance, checkModel, checkTrace } from "../src/index.js";

export const registerEvaluationContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("mixed-depth search alternates short and long cases under one operation budget", async () => {
    const corpus = generateCorpus(counterModel, "alternating", {
      seed: 7,
      maxOperations: 100,
      maxDepth: 16,
    });
    assert.deepEqual(
      corpus.cases.slice(0, 2).map((actions) => actions.length),
      [8, 16],
    );
    assert.equal(corpus.operations, 100);
    for (const actions of corpus.cases)
      assert.equal(
        (await checkConformance(counterModel, createCounter(), actions)).status,
        "matched",
      );
  });
  test("complete model coverage can miss a third-retry implementation fault", async () => {
    const oracle = checkModel(counterModel, { maxDepth: 12, maxStates: 1000 });
    assert.equal(oracle.status, "complete");
    for (const trace of oracle.traces)
      assert.equal(
        (await checkTrace(trace, createFaultyCounter("late-retry"))).status,
        "matched",
      );
    const actions = Array.from({ length: 3 }, () => ({
      type: "add" as const,
      id: "a",
      amount: 1,
    }));
    assert.equal(
      (
        await checkConformance(
          counterModel,
          createFaultyCounter("late-retry"),
          actions,
        )
      ).status,
      "mismatch",
    );
    assert.equal(
      (await checkConformance(counterModel, createCounter(), actions)).status,
      "matched",
    );
  });

  test("both experimental searches obey the same operation budget and replay on the normal implementation", async () => {
    for (const strategy of ["uniform", "novelty"] as const) {
      const first = generateCorpus(counterModel, strategy, {
        seed: 7,
        maxOperations: 64,
        maxDepth: 8,
      });
      assert.deepEqual(
        generateCorpus(counterModel, strategy, {
          seed: 7,
          maxOperations: 64,
          maxDepth: 8,
        }),
        first,
      );
      assert.ok(first.operations <= 64);
      assert.ok(first.operations >= 63);
      assert.equal(
        first.operations,
        first.cases.reduce((total, actions) => total + actions.length + 1, 0),
      );
      for (const actions of first.cases) {
        assert.ok(actions.length <= 8 && actions.length > 0);
        assert.equal(
          (await checkConformance(counterModel, createCounter(), actions))
            .status,
          "matched",
        );
      }
    }
    assert.throws(
      () =>
        generateCorpus(counterModel, "uniform", {
          seed: 0,
          maxOperations: 0,
          maxDepth: 8,
        }),
      RangeError,
    );
  });

  test("a virtual clock reproduces the expiry boundary and the corrected version passes", async () => {
    const actions = [
      { type: "put" as const, ttl: 7 },
      { type: "advance" as const, amount: 7 },
      { type: "read" as const },
    ];
    const bad = await checkConformance(
      ttlModel,
      createTtlDriver(true),
      actions,
    );
    assert.equal(bad.status, "mismatch");
    assert.equal(bad.actual, "cached");
    assert.deepEqual(bad.expected, [null]);
    assert.equal(
      (await checkConformance(ttlModel, createTtlDriver(false), actions))
        .status,
      "matched",
    );
  });

  test("state-dependent inputs remain executable when the choice list shrinks", async () => {
    for (const choices of [
      [],
      [9],
      [5, 6, 7, 8],
      [0, 65535, 3, 11, 0, 8, 91],
    ]) {
      for (let length = 0; length <= choices.length; length++) {
        const actions = enabledActions(counterModel, choices.slice(0, length));
        assert.equal(
          (await checkConformance(counterModel, createCounter(), actions))
            .status,
          "matched",
        );
      }
    }
    assert.throws(() => enabledActions(counterModel, [-1]), RangeError);
  });

  test("history checking accepts overlapping valid operations, rejects lost updates, and respects real-time precedence", () => {
    const valid = [
      { id: "a", call: 0, returned: 3, input: 1, output: 1 },
      { id: "b", call: 1, returned: 2, input: 1, output: 2 },
    ];
    assert.equal(
      checkHistory(incrementHistoryModel, valid, 100).status,
      "linearizable",
    );
    assert.equal(
      checkHistory(
        incrementHistoryModel,
        valid.map((entry) => ({ ...entry, output: 1 })),
        100,
      ).status,
      "not-linearizable",
    );
    const backwards = [
      { id: "a", call: 0, returned: 1, input: 1, output: 2 },
      { id: "b", call: 2, returned: 3, input: 1, output: 1 },
    ];
    assert.equal(
      checkHistory(incrementHistoryModel, backwards, 100).status,
      "not-linearizable",
    );
    assert.equal(
      checkHistory(incrementHistoryModel, valid, 1).status,
      "inconclusive",
    );
    assert.equal(checkHistory(incrementHistoryModel, [], 1).status, "empty");
    assert.throws(
      () =>
        checkHistory(
          incrementHistoryModel,
          [
            {
              ...valid[0],
              id: "bad",
              call: 3,
              returned: 0,
              input: 1,
              output: 1,
            },
          ],
          100,
        ),
      /history/,
    );
  });

  test("actual asynchronous lost updates depend on the controlled schedule and replay exactly", async () => {
    const sequential = await runScheduledCounter(
      true,
      [1, 2, 3, 4],
      "sequential",
    );
    assert.equal(
      checkHistory(incrementHistoryModel, sequential.history, 100).status,
      "linearizable",
    );
    const serial = await runScheduledCounter(true, [1, 3, 2, 4]);
    const lost = await runScheduledCounter(true, [1, 2, 3, 4]);
    const fixed = await runScheduledCounter(false, [1, 2, 3, 4]);
    assert.equal(
      checkHistory(incrementHistoryModel, serial.history, 100).status,
      "linearizable",
    );
    assert.equal(
      checkHistory(incrementHistoryModel, lost.history, 100).status,
      "not-linearizable",
    );
    assert.equal(
      checkHistory(incrementHistoryModel, fixed.history, 100).status,
      "linearizable",
    );
    assert.deepEqual(await runScheduledCounter(true, lost.ordering), lost);
  });

  test("the experimental history checker agrees with an independent counter characterization", () => {
    const layouts = [
      [
        [0, 3],
        [1, 4],
        [2, 5],
      ],
      [
        [0, 1],
        [2, 3],
        [4, 5],
      ],
      [
        [0, 2],
        [1, 3],
        [4, 5],
      ],
    ];
    for (const layout of layouts) {
      for (let code = 0; code < 64; code++) {
        const operations = layout.map((interval, index) => ({
          id: String(index),
          call: interval[0] ?? 0,
          returned: interval[1] ?? 0,
          input: 1,
          output: Math.floor(code / 4 ** index) % 4,
        }));
        const expected =
          operations
            .map((entry) => entry.output)
            .sort()
            .join(",") === "1,2,3" &&
          operations.every((entry) =>
            operations.every(
              (other) =>
                entry.returned >= other.call || entry.output < other.output,
            ),
          );
        assert.equal(
          checkHistory(incrementHistoryModel, operations, 100).status ===
            "linearizable",
          expected,
        );
      }
    }
  });
};
