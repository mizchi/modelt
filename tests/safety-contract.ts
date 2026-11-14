import assert from "node:assert/strict";
import { compileTlaSafety } from "../src/tla-safety.js";

export const registerSafetyContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  const source =
    "---- MODULE Counter ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = x + 1\nSafe == x < 3\n====";
  const config = "INIT Init\nNEXT Next\nINVARIANT Safe";
  test("safety compilation produces a portable program without enumerating reachable states", () => {
    const program = compileTlaSafety({ source, config });
    assert.deepEqual(program.variables, ["x"]);
    assert.equal(program.format, "modelt.safety-program");
    assert.equal(program.next.length, 1);
    assert.ok(JSON.stringify(program).length < 1000);
    assert.equal(program.invariants[0]?.name, "Safe");
  });
  test("safety compilation rejects temporal and unsupported configuration instead of ignoring it", () => {
    for (const suffix of [
      "PROPERTY Safe",
      "CONSTRAINT Safe",
      "ACTION_CONSTRAINT Next",
      "VIEW x",
      "SYMMETRY Safe",
      "POSTCONDITION Safe",
    ])
      assert.throws(() =>
        compileTlaSafety({ source, config: `${config}\n${suffix}` }),
      );
    assert.throws(() =>
      compileTlaSafety({ source, config: "SPECIFICATION Spec" }),
    );
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("Naturals", "Sequences"),
        config,
      }),
    );
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("x' = x + 1", "x' = <<x>>"),
        config,
      }),
    );
  });
  test("safety compilation rejects missing arithmetic imports and constant NEXT", () => {
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("EXTENDS Naturals\n", ""),
        config,
      }),
    );
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("x' = x + 1", "FALSE"),
        config,
      }),
    );
  });
  test("safety compilation rejects unbound, recursive and conflicting symbols", () => {
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("x + 1", "missing + 1"),
        config,
      }),
    );
    assert.throws(() =>
      compileTlaSafety({ source: source.replace("x + 1", "Next"), config }),
    );
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("VARIABLE x", "VARIABLE x\nF(x) == x"),
        config,
      }),
    );
    assert.throws(() =>
      compileTlaSafety({
        source: source.replace("Safe == x < 3", "Safe == x' < 3"),
        config,
      }),
    );
  });
};
