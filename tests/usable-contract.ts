import assert from "node:assert/strict";
import { counterModel } from "../examples/counter-model.js";
import { checkModel } from "../src/checker.js";
import {
  compileFiniteModel,
  createFiniteModel,
  parseFiniteModel,
} from "../src/finite.js";
import { createSimulationHost } from "../src/host.js";
import { deletionCandidates, shrinkCounterexample } from "../src/shrink.js";

export const registerUsableContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("finite artifacts retain closure, edge observations and invariants", () => {
    const result = compileFiniteModel(counterModel, {
      maxDepth: 20,
      maxStates: 1000,
    });
    assert.equal(result.status, "complete");
    assert.ok(result.model);
    const artifact = result.model;
    const restored = createFiniteModel(
      parseFiniteModel(JSON.parse(JSON.stringify(result.model))),
    );
    assert.equal(
      checkModel(restored, { maxDepth: 20, maxStates: 1000 }).status,
      "complete",
    );
    assert.equal(result.model.states.length, 56);
    const bounded = compileFiniteModel(counterModel, {
      maxDepth: 0,
      maxStates: 1,
    });
    assert.equal(bounded.status, "bounded");
    assert.equal(bounded.model, undefined);
    assert.throws(() => parseFiniteModel({ ...result.model, version: 2 }));
    assert.throws(() =>
      parseFiniteModel({
        ...artifact,
        states: [...artifact.states, artifact.states[0]],
      }),
    );
  });
  test("finite edges preserve differing observations for the same target state", () => {
    const compiled = compileFiniteModel(
      {
        name: "edge-observations",
        initial: () => [{ state: 0, observation: 0 }],
        actions: () => [1, 2],
        step: (_state: number, action: number) => [
          { state: 0, observation: action },
        ],
        key: String,
      },
      { maxDepth: 0, maxStates: 1 },
    );
    assert.ok(compiled.model);
    const model = createFiniteModel(compiled.model);
    const state = model.initial()[0];
    assert.ok(state);
    assert.notDeepEqual(
      model.step(state.state, { type: "int", value: "1" }),
      model.step(state.state, { type: "int", value: "2" }),
    );
  });
  test("finite artifacts preserve violations and do not duplicate enabled actions", () => {
    const result = compileFiniteModel(
      {
        name: "unsafe",
        initial: () => [{ state: 0, observation: 0 }],
        key: String,
        actions: () => [1, 1],
        step: () => [{ state: 1, observation: 1 }],
        invariants: [
          { name: "zero-only", check: (state: number) => state === 0 },
        ],
      },
      { maxDepth: 2, maxStates: 2 },
    );
    assert.ok(result.model);
    assert.equal(result.model.states[0]?.transitions.length, 1);
    const checked = checkModel(createFiniteModel(result.model), {
      maxDepth: 2,
      maxStates: 2,
    });
    assert.equal(checked.status, "violation");
    assert.equal(checked.violation?.invariant, "zero-only");
  });
  test("shrinking preserves failure identity, validity and explicit budgets", async () => {
    const evaluate = async (actions: readonly string[]) =>
      actions.includes("bad")
        ? { status: "mismatch" as const, signature: "bug" }
        : actions.includes("other")
          ? { status: "mismatch" as const, signature: "different" }
          : { status: "invalid" as const };
    const result = await shrinkCounterexample(
      ["noise", "bad", "noise", "other"],
      evaluate,
      { maxChecks: 100 },
    );
    assert.equal(result.status, "minimal");
    assert.deepEqual(result.actions, ["bad"]);
    assert.equal(
      (await shrinkCounterexample(["noise", "bad"], evaluate, { maxChecks: 2 }))
        .status,
      "bounded",
    );
    assert.equal(
      (await shrinkCounterexample(["noise"], evaluate, { maxChecks: 5 }))
        .status,
      "not-failing",
    );
    assert.deepEqual(deletionCandidates(0), []);
    assert.ok(deletionCandidates(5).some((range) => range.count === 1));
    await assert.rejects(
      shrinkCounterexample(["bad"], evaluate, {
        maxChecks: 5,
        candidates: () => [],
      }),
      /single deletion/,
    );
  });
  test("simulation hosts replay choices, queues, clocks and durable state", () => {
    const host = createSimulationHost({ seed: 3 });
    host.write("value", 1);
    host.persist();
    host.write("value", 2);
    host.send("a", "b", { value: 1 });
    host.send("b", "a", { value: 2 });
    const first = host.deliver(1);
    host.drop(0);
    const chosen = host.choose("election", ["a", "b"]);
    host.advance(10);
    host.crash();
    assert.throws(() => host.read("value"));
    host.restart();
    assert.equal(host.read("value"), 1);
    assert.equal(host.now(), 10);
    const tape = host.trace();
    const replay = createSimulationHost({
      replay: JSON.parse(JSON.stringify(tape)),
    });
    replay.write("value", 1);
    replay.persist();
    replay.write("value", 2);
    replay.send("a", "b", { value: 1 });
    replay.send("b", "a", { value: 2 });
    assert.deepEqual(replay.deliver(1), first);
    replay.drop(0);
    assert.equal(replay.choose("election", ["a", "b"]), chosen);
    replay.advance(10);
    replay.crash();
    replay.restart();
    replay.finish();
    assert.throws(() => createSimulationHost({ replay: tape }).advance(1));
    assert.throws(() => createSimulationHost({ replay: tape }).finish());
    const empty = createSimulationHost({
      replay: { format: "modelt.host-tape", version: 1, events: [] },
    });
    assert.throws(() => empty.advance(1));
    assert.throws(() => empty.finish());
    assert.throws(() => host.advance(Number.MAX_SAFE_INTEGER));
  });
};
