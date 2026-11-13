import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { KernelOptions, KernelResult } from "./table.js";

const execute = promisify(execFile);

export const runNative = async (
  binary: string,
  tablePath: string,
  options: KernelOptions,
): Promise<{ result: KernelResult; kernelMs: number }> => {
  if (options.trace)
    throw new Error("Use the Wasm ABI for portable trace extraction");
  const output = await execute(binary, [
    tablePath,
    String(options.seed),
    String(options.operations),
    String(options.depth),
    String(options.strategy),
    String(options.repeats),
  ]);
  const values = output.stdout.trim().split(",").map(Number);
  if (
    values.length !== 5 ||
    values.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw new Error("Invalid native probe output");
  const cases = values[0];
  const operations = values[1];
  const steps = values[2];
  const checksum = values[3];
  const nanos = values[4];
  if (
    cases === undefined ||
    operations === undefined ||
    steps === undefined ||
    checksum === undefined ||
    nanos === undefined
  )
    throw new Error("Missing native probe output");
  return {
    result: { cases, operations, steps, checksum, trace: [] },
    kernelMs: nanos / 1_000_000,
  };
};
