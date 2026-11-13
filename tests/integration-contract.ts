import assert from "node:assert/strict";
import { init, killThreads } from "z3-solver";
import { counterModel, createCounter } from "../examples/durable-counter.js";
import { checkConformance, checkTrace } from "../src/index.js";
import { createSmtOracle } from "../src/smt.js";
import { generateTlaOracle } from "../src/tla.js";

const source = `---- MODULE Counter ----
EXTENDS Naturals
VARIABLE value
Init == value = 0
Next == /\\ value < 2
        /\\ value' = value + 1
BelowTwo == value < 2
====`;

export const registerIntegrationContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("a real TLA+ counterexample becomes an executable implementation oracle", async () => {
    const oracle = await generateTlaOracle(
      {
        source,
        config:
          "INIT Init\nNEXT Next\nINVARIANT BelowTwo\nCHECK_DEADLOCK FALSE",
      },
      {
        name: "tla-counter",
        observation: (step) => {
          assert.equal(typeof step.state.value, "number");
          if (typeof step.state.value !== "number")
            throw new Error("Expected integer value");
          return step.state.value;
        },
        action: () => "increment",
      },
    );
    assert.equal(oracle.check.status, "invariant-violation");
    assert.ok(oracle.trace);
    assert.equal(oracle.trace.steps.length, 2);
    let value = 0;
    const result = await checkTrace(oracle.trace, {
      reset: () => {
        value = 0;
        return value;
      },
      step: () => ++value,
    });
    assert.equal(result.status, "matched");
  });

  test("a successful TLA check does not fabricate a witness", async () => {
    const oracle = await generateTlaOracle(
      { source, config: "INIT Init\nNEXT Next\nCHECK_DEADLOCK FALSE" },
      {
        name: "tla-counter",
        observation: (step) => step.state.value,
        action: () => "increment",
      },
    );
    assert.equal(oracle.check.status, "success");
    assert.equal(oracle.trace, undefined);
  });

  test("Z3 Wasm solves SMT-LIB integer constraints and supplies a concrete test input", async () => {
    const api = await init();
    try {
      const oracle = createSmtOracle(api);
      const solution = await oracle.solve(
        `
        (set-logic QF_LIA)
        (declare-const amount Int)
        (declare-const other Int)
        (assert (and (> amount 0) (< amount 10) (= other 3) (= (+ amount other) 10)))
      `,
        ["amount", "other"],
      );
      assert.equal(solution.status, "sat");
      assert.deepEqual(solution.values, { amount: "7", other: "3" });
      const amount = Number(solution.values.amount);
      const result = await checkConformance(counterModel, createCounter(), [
        { type: "add", id: "smt", amount },
      ]);
      assert.equal(result.status, "matched");
      assert.deepEqual(result.actual, { running: true, value: 7 });
      assert.equal((await oracle.solve("(assert false)", [])).status, "unsat");
      await assert.rejects(
        oracle.solve("(assert true)", ["missing"]),
        /not an assigned integer/,
      );
    } finally {
      await killThreads(api.em);
    }
  });
};
