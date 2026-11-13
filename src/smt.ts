import type { init } from "z3-solver";

export interface SmtRuntime {
  readonly Context: Awaited<ReturnType<typeof init>>["Context"];
}

export interface SmtResult {
  readonly status: "sat" | "unsat" | "unknown";
  readonly values: Readonly<Record<string, string>>;
  readonly reason?: string;
}

export interface SmtOracle {
  readonly solve: (
    assertions: string,
    integers: readonly string[],
  ) => Promise<SmtResult>;
}

export class SmtValueError extends Error {
  override readonly name = "SmtValueError";
}

export const createSmtOracle = (runtime: SmtRuntime): SmtOracle => {
  const context = new runtime.Context("modelt");
  let pending: Promise<void> = Promise.resolve();
  return {
    solve: (assertions, integers) => {
      const result = pending.then(async (): Promise<SmtResult> => {
        const solver = new context.Solver();
        try {
          solver.fromString(assertions);
          const status = await solver.check();
          if (status === "unknown")
            return { status, values: {}, reason: solver.reasonUnknown() };
          if (status === "unsat") return { status, values: {} };
          const model = solver.model();
          try {
            const values = Object.fromEntries(
              integers.map((name) => {
                const value = model.eval(context.Int.const(name));
                if (!context.isIntVal(value))
                  throw new SmtValueError(`${name} is not an assigned integer`);
                return [name, value.value().toString()];
              }),
            );
            return { status, values };
          } finally {
            model.release();
          }
        } finally {
          solver.release();
        }
      });
      pending = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
};
