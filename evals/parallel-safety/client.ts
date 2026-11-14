import type {
  ScheduledCompletion,
  ScheduledExecutor,
} from "../../src/contracts.js";
import { decodeSafetyResult } from "../../src/safety.js";
import { SchedulingError } from "../../src/scheduling.js";
import { isRecord } from "../../src/trace.js";
import type { SafetyOutcome } from "./protocol.js";

export interface MessagePort {
  readonly send: (message: unknown) => void;
  readonly subscribe: (
    message: (value: unknown) => void,
    error: (reason: Error) => void,
  ) => void;
  readonly close: () => Promise<void>;
}
export const createClient = (port: MessagePort) => {
  let stopped: Error | undefined;
  let sequence = 0;
  let pending:
    | {
        readonly id: number;
        readonly resolve: (
          value: readonly ScheduledCompletion<SafetyOutcome>[],
        ) => void;
        readonly reject: (error: Error) => void;
      }
    | undefined;
  let markReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};
  let initialized = false;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  const fail = (error: Error) => {
    stopped = error;
    rejectReady(error);
    pending?.reject(error);
    pending = undefined;
  };
  port.subscribe((message) => {
    try {
      if (!isRecord(message))
        throw new SchedulingError("Invalid worker message");
      if (!initialized && message.type === "ready") {
        initialized = true;
        markReady();
        return;
      }
      if (
        !pending ||
        message.id !== pending.id ||
        message.type !== "result" ||
        !Array.isArray(message.completed)
      )
        throw new SchedulingError("Unexpected worker response");
      const completed = message.completed.map(
        (entry: unknown): ScheduledCompletion<SafetyOutcome> => {
          if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            !isRecord(entry.result)
          )
            throw new SchedulingError("Invalid task response");
          const result = entry.result;
          if (result.status === "ok")
            return {
              id: entry.id,
              result: {
                status: "ok",
                result: decodeSafetyResult(result.result),
              },
            };
          if (
            result.status !== "error" ||
            typeof result.code !== "string" ||
            typeof result.message !== "string"
          )
            throw new SchedulingError("Invalid task error");
          return {
            id: entry.id,
            result: {
              status: "error",
              code: result.code,
              message: result.message,
            },
          };
        },
      );
      pending.resolve(completed);
      pending = undefined;
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  }, fail);
  const executor: ScheduledExecutor<SafetyOutcome> = {
    execute: async (ids) => {
      await ready;
      if (stopped) throw stopped;
      if (pending)
        throw new SchedulingError("Worker already executing a batch");
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending = { id, resolve, reject };
        try {
          port.send({ type: "run", id, ids });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
  };
  return {
    ready,
    executor,
    close: async () => {
      fail(new SchedulingError("Worker closed"));
      await port.close();
    },
  };
};
