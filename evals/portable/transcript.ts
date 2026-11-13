import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type {
  PortableCommand,
  PortableCore,
  PortableOutput,
} from "../../src/contracts.js";
import { createPortableWasm } from "../../src/portable.js";

export const createNativeComparison = async (bytes: Uint8Array) => {
  const start = performance.now();
  const wasm = await createPortableWasm(bytes);
  const startupMs = performance.now() - start;
  const commands: PortableCommand[] = [];
  const outputs: PortableOutput[] = [];
  const core: PortableCore = {
    request: (command) => {
      commands.push(structuredClone(command));
      const output = wasm.request(command);
      outputs.push(output);
      return output;
    },
  };
  return {
    core,
    startupMs,
    verify: () => {
      const start = performance.now();
      const native = execFileSync(
        "crates/modelt-core/target/release/modelt-core",
        {
          input: commands.map((command) => JSON.stringify(command)).join("\n"),
          maxBuffer: 64 * 1024 * 1024,
        },
      )
        .toString()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(native.length, outputs.length, "Native reply count differs");
      for (const [index, output] of outputs.entries())
        assert.deepEqual(
          native[index],
          output,
          `Native/Wasm reply ${index} differs`,
        );
      return { replies: native.length, elapsedMs: performance.now() - start };
    },
  };
};
