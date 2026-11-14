import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { check } from "tla-ts";
import { createPortableWasm } from "../../src/portable-wasm.js";
import { checkSafety, decodeSafetyResult } from "../../src/safety.js";
import { compileTlaSafety } from "../../src/tla-safety.js";
import { isRecord } from "../../src/trace.js";
import { startNative } from "../usable/native.js";
import { bounds, type Input, type WarmRoute } from "./protocol.js";

export const wasmPath =
  "crates/modelt-core/target/wasm32-unknown-unknown/release/modelt_core.wasm";
export const nativePath = "crates/modelt-core/target/release/modelt-core";

export const loadEngines = async (routes: readonly WarmRoute[]) => {
  const core = routes.includes("modelt-wasm")
    ? await createPortableWasm(await readFile(wasmPath))
    : undefined;
  const native = routes.includes("modelt-native") ? startNative() : undefined;
  return {
    run: async (route: WarmRoute, input: Input) => {
      if (route === "tla-ts") {
        const result = await check({
          source: input.source,
          config: input.config,
          version: "1.7.4",
          workers: 1,
          livenessCheck: "final",
        });
        return {
          status: result.status === "success" ? "complete" : result.status,
          states: result.distinctStates,
          generated: result.generatedStates,
          violation: result.status === "success" ? null : result,
        };
      }
      const program = compileTlaSafety(input);
      if (route === "modelt-wasm") {
        assert.ok(core);
        return checkSafety(core, program, bounds);
      }
      assert.ok(native);
      const response = await native.request({
        version: 1,
        request: { kind: "check-safety", program, bounds },
      });
      assert.ok(isRecord(response) && response.kind === "safety");
      return decodeSafetyResult(response.result);
    },
    close: async () => {
      await native?.close();
    },
  };
};
