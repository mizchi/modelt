import {
  type CounterTable,
  type KernelOptions,
  type KernelResult,
  validateKernelOptions,
} from "./table.js";

export interface WasmKernel {
  readonly run: (options: KernelOptions) => KernelResult;
  readonly bytes: number;
}

export const encodeTable = (table: CounterTable): Uint8Array<ArrayBuffer> => {
  const words = [
    table.offsets.length - 1,
    table.actions.length,
    ...table.offsets,
    ...table.actions,
    ...table.targets,
  ];
  const bytes = new Uint8Array(words.length * 4);
  const view = new DataView(bytes.buffer);
  words.forEach((value, index) => {
    view.setUint32(index * 4, value, true);
  });
  return bytes;
};

export const createWasmKernel = async (
  bytes: Uint8Array,
  table: CounterTable,
): Promise<WasmKernel> => {
  const instantiated = await WebAssembly.instantiate(Uint8Array.from(bytes));
  const exports = instantiated.instance.exports;
  const call = (name: string, ...args: number[]): number => {
    const method = exports[`modelt_probe_${name}`];
    if (typeof method !== "function")
      throw new Error(`Missing Wasm ABI function: ${name}`);
    const result: unknown = method(...args);
    if (typeof result !== "number") throw new Error("Invalid Wasm ABI result");
    return result >>> 0;
  };
  call("begin", table.offsets.length - 1, table.actions.length);
  table.offsets.forEach((value, index) => {
    if (call("offset", index, value) !== 1)
      throw new Error("Invalid Wasm offset");
  });
  table.actions.forEach((action, index) => {
    if (call("edge", index, action, table.targets[index] ?? 0) !== 1)
      throw new Error("Invalid Wasm edge");
  });
  return {
    bytes: bytes.byteLength,
    run: (options) => {
      validateKernelOptions(options);
      if (
        call(
          "run",
          options.seed,
          options.operations,
          options.depth,
          options.strategy,
          options.repeats,
          Number(options.trace),
        ) !== 1
      )
        throw new Error("Rust rejected the model or budget");
      const memory = exports.memory;
      if (!(memory instanceof WebAssembly.Memory))
        throw new Error("Missing Wasm memory");
      const trace = options.trace
        ? Array.from(
            new Uint32Array(
              memory.buffer,
              call("trace_ptr"),
              call("trace_len"),
            ),
          )
        : [];
      return {
        cases: call("cases"),
        operations: call("operations"),
        steps: call("steps"),
        checksum: call("checksum"),
        trace,
      };
    },
  };
};
