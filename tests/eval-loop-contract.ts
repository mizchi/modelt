import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareTrials } from "../evals/benchmark.js";
import { parsePlan } from "../evals/protocol.js";
import { readPlan, runEvaluation } from "../evals/runner.js";

export const registerEvalLoopContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("plans reject overlapping seed splits and unsupported scope", async () => {
    const plan = await readPlan("evals/plans/0001-longer-walk.json");
    assert.throws(() => parsePlan({ ...plan, confirmationSeeds: [1] }), /seed/);
    assert.throws(() => parsePlan({ ...plan, scope: "unknown" }), /scope/);
  });

  test("completed runs retain evidence and cannot overwrite an existing run ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "modelt-evals-"));
    try {
      const plan = await readPlan("evals/plans/0001-longer-walk.json");
      const small = {
        ...plan,
        developmentSeeds: [1],
        confirmationSeeds: [2],
        maxOperations: 32,
      };
      const development = await runEvaluation(
        small,
        "development",
        "dev",
        root,
      );
      assert.equal(development.status, "complete");
      assert.ok(
        (await readFile(join(root, "dev", "manifest.json"), "utf8")).includes(
          "sourceDigest",
        ),
      );
      assert.ok(
        (await readFile(join(root, "dev", "trials.json"), "utf8")).includes(
          "firstFailureOperations",
        ),
      );
      await assert.rejects(
        runEvaluation(small, "development", "dev", root),
        /EEXIST/,
      );
      const confirmation = await runEvaluation(
        small,
        "confirmation",
        "confirmation",
        root,
        "dev",
      );
      assert.equal(confirmation.status, "complete");
      const changed = {
        ...small,
        candidate: { ...small.candidate, maxDepth: 12 },
      };
      await assert.rejects(
        runEvaluation(changed, "confirmation", "changed", root, "dev"),
        /plan/,
      );
      await assert.rejects(
        runEvaluation(small, "confirmation", "orphan", root),
        /development/,
      );
      await assert.rejects(
        runEvaluation(small, "development", "../escape", root),
        /run ID/,
      );
      await writeFile(join(root, "dev", "trials.json"), "[]");
      await assert.rejects(
        runEvaluation(small, "confirmation", "corrupt", root, "dev"),
        /evaluation evidence/,
      );
      assert.equal(
        (await readFile(join(root, "ledger.jsonl"), "utf8")).trim().split("\n")
          .length,
        2,
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  test("method comparison keeps improvements, regressions and broken controls distinct", () => {
    const row = {
      seed: 1,
      method: "baseline",
      fault: "late-retry",
      detected: false,
      invalid: 0,
      operations: 10,
      resets: 2,
      elapsedMs: 0,
      firstFailureOperations: null,
      firstFailureLength: null,
      replayed: null,
      fixedPassed: null,
    };
    const normal = { ...row, fault: "none" };
    const candidate = {
      ...row,
      method: "candidate",
      detected: true,
      firstFailureOperations: 8,
      firstFailureLength: 3,
      replayed: true,
      fixedPassed: true,
    };
    assert.equal(
      compareTrials(
        [row, candidate, normal, { ...normal, method: "candidate" }],
        "baseline",
        "candidate",
      ).assessment,
      "improved",
    );
    assert.equal(
      compareTrials(
        [
          { ...row, detected: true, replayed: true, fixedPassed: true },
          { ...candidate, detected: false, replayed: null, fixedPassed: null },
          normal,
          { ...normal, method: "candidate" },
        ],
        "baseline",
        "candidate",
      ).assessment,
      "regressed",
    );
    assert.equal(
      compareTrials(
        [
          row,
          candidate,
          normal,
          { ...normal, method: "candidate", detected: true },
        ],
        "baseline",
        "candidate",
      ).assessment,
      "controls-failed",
    );
    assert.throws(
      () => compareTrials([row, candidate], "baseline", "candidate"),
      /control/,
    );
  });
};
