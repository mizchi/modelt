import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  decodePortableTrace,
  encodePortableTrace,
  fromPortableValue,
  normalizePortableValue,
  PortableCoreError,
  toPortableValue,
} from "../src/portable.js";

export const registerPortableContract = (
  test: (name: string, run: () => void | Promise<void>) => unknown,
): void => {
  test("portable values follow the shared canonical fixtures", async () => {
    const fixtures = JSON.parse(
      await readFile("fixtures/portable-values.json", "utf8"),
    );
    for (const fixture of fixtures.valid) {
      const normalized = normalizePortableValue(fixture.input);
      assert.equal(JSON.stringify(normalized), fixture.canonical, fixture.name);
      assert.deepEqual(normalizePortableValue(normalized), normalized);
    }
    for (const fixture of fixtures.invalid)
      assert.throws(
        () =>
          normalizePortableValue(
            fixture.json ? JSON.parse(fixture.json) : fixture.input,
          ),
        PortableCoreError,
        fixture.name,
      );
  });
  test("portable codecs preserve integer precision and structural collections", () => {
    const original = {
      integer: 9007199254740993123456789n,
      bytes: new Uint8Array([0, 255]),
      list: [null, true, "😀"],
      set: new Set([2, 1]),
      map: new Map([["x", 4]]),
    };
    const roundtrip = fromPortableValue(toPortableValue(original));
    assert.deepEqual(roundtrip, original);
    assert.deepEqual(
      toPortableValue(new Set([1, 2, 1])),
      toPortableValue(new Set([2, 1])),
    );
    assert.notDeepEqual(toPortableValue([1, 2]), toPortableValue([2, 1]));
    const record = fromPortableValue(
      toPortableValue(JSON.parse('{"__proto__":1}')),
    );
    assert.ok(typeof record === "object" && record !== null);
    assert.equal(Object.hasOwn(record, "__proto__"), true);
  });
  test("portable values reject lossy or unsupported host values", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    for (const value of [
      undefined,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      "\ud800",
      cyclic,
      new Date(),
    ])
      assert.throws(() => toPortableValue(value), PortableCoreError);
  });
  test("portable traces have a distinct strict versioned format", () => {
    const trace = {
      format: "modelt.portable-trace" as const,
      version: 1 as const,
      model: "counter",
      initial: toPortableValue(0),
      steps: [
        { action: toPortableValue("add"), observation: toPortableValue(1) },
      ],
    };
    assert.deepEqual(decodePortableTrace(encodePortableTrace(trace)), trace);
    assert.throws(
      () => decodePortableTrace(JSON.stringify({ ...trace, version: 2 })),
      PortableCoreError,
    );
    assert.throws(
      () =>
        decodePortableTrace(
          JSON.stringify({
            version: 1,
            model: "legacy",
            initial: 0,
            steps: [],
          }),
        ),
      PortableCoreError,
    );
    assert.throws(
      () => decodePortableTrace(JSON.stringify({ ...trace, extra: true })),
      PortableCoreError,
    );
  });
};
