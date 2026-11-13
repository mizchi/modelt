import type {
  HostMessage,
  HostTape,
  PortableValue,
  SimulationHost,
} from "./contracts.js";
import {
  fromPortableValue,
  normalizePortableValue,
  toPortableValue,
} from "./portable-value.js";
import { isRecord } from "./trace.js";

export type { HostMessage, HostTape, SimulationHost } from "./contracts.js";

export class HostReplayError extends Error {
  override readonly name = "HostReplayError";
}
export const createSimulationHost = (
  options: { readonly seed?: number; readonly replay?: HostTape } = {},
): SimulationHost => {
  if (
    !Number.isSafeInteger(options.seed ?? 1) ||
    (options.seed ?? 1) < 1 ||
    (options.seed ?? 1) > 0xffff_ffff
  )
    throw new RangeError("Invalid simulation seed");
  const replay: unknown = options.replay;
  if (
    replay !== undefined &&
    (!isRecord(replay) ||
      replay.format !== "modelt.host-tape" ||
      replay.version !== 1 ||
      !Array.isArray(replay.events) ||
      Object.keys(replay).length !== 3)
  )
    throw new HostReplayError("Unsupported host tape");
  const source = options.replay?.events.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.operation !== "string" ||
      Object.keys(event).length !== 3
    )
      throw new HostReplayError("Invalid tape event");
    return {
      operation: event.operation,
      input: normalizePortableValue(event.input),
      output: normalizePortableValue(event.output),
    };
  });
  const events: HostTape["events"][number][] = [];
  let cursor = 0;
  let closed = false;
  let failed = false;
  let running = true;
  let clock = 0;
  let random = options.seed ?? 1;
  let nextMessage = 1;
  let volatile = new Map<string, PortableValue>();
  let durable = new Map<string, PortableValue>();
  const messages: HostMessage[] = [];
  const requireRunning = () => {
    if (!running || closed) throw new HostReplayError("Host is stopped");
  };
  const event = (
    operation: string,
    input: unknown,
    produce: (recorded?: PortableValue) => unknown,
  ): PortableValue => {
    if (closed) throw new HostReplayError("Host tape is closed");
    const encoded = toPortableValue(input);
    const expected = source?.[cursor];
    if (
      source &&
      (!expected ||
        expected.operation !== operation ||
        JSON.stringify(expected.input) !== JSON.stringify(encoded))
    ) {
      failed = true;
      throw new HostReplayError("Host request differs from replay");
    }
    const output = toPortableValue(produce(expected?.output));
    if (
      expected &&
      JSON.stringify(expected.output) !== JSON.stringify(output)
    ) {
      closed = true;
      failed = true;
      throw new HostReplayError("Host output differs from replay");
    }
    events.push({ operation, input: encoded, output });
    cursor++;
    return output;
  };
  const select = (index: number): HostMessage => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= messages.length)
      throw new RangeError("Invalid message index");
    const message = messages[index];
    if (!message) throw new RangeError("Missing message");
    return message;
  };
  return {
    now: () => clock,
    advance: (amount) => {
      if (
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        !Number.isSafeInteger(clock + amount)
      )
        throw new RangeError("Invalid clock advance");
      event("advance", amount, () => {
        clock += amount;
        return clock;
      });
    },
    choose: (label, choices) => {
      if (choices.length === 0) throw new RangeError("No simulation choices");
      const selected = fromPortableValue(
        event("choose", { label, choices }, (recorded) => {
          if (recorded) {
            const index = fromPortableValue(recorded);
            if (
              typeof index !== "number" ||
              !Number.isSafeInteger(index) ||
              index < 0 ||
              index >= choices.length
            )
              throw new HostReplayError("Invalid recorded choice");
            return index;
          }
          random ^= random << 13;
          random ^= random >>> 17;
          random ^= random << 5;
          return (random >>> 0) % choices.length;
        }),
      );
      if (typeof selected !== "number")
        throw new HostReplayError("Invalid selected index");
      const choice = choices[selected];
      if (choice === undefined)
        throw new HostReplayError("Missing selected choice");
      return choice;
    },
    send: (from, to, payload) => {
      requireRunning();
      const message = {
        id: nextMessage,
        from,
        to,
        payload: toPortableValue(payload),
      };
      event("send", { from, to, payload }, () => {
        messages.push(message);
        nextMessage++;
        return message.id;
      });
      return message.id;
    },
    deliver: (index) => {
      requireRunning();
      const message = select(index);
      event("deliver", { index, id: message.id }, () => {
        messages.splice(index, 1);
        return { ...message, payload: fromPortableValue(message.payload) };
      });
      return { ...message, payload: normalizePortableValue(message.payload) };
    },
    drop: (index) => {
      const message = select(index);
      event("drop", { index, id: message.id }, () => {
        messages.splice(index, 1);
        return null;
      });
    },
    pending: () =>
      messages.map((message) => ({
        ...message,
        payload: normalizePortableValue(message.payload),
      })),
    write: (key, value) => {
      requireRunning();
      const encoded = toPortableValue(value);
      event("write", { key, value }, () => {
        volatile.set(key, encoded);
        return null;
      });
    },
    read: (key) => {
      requireRunning();
      const value = volatile.get(key);
      return value === undefined ? undefined : fromPortableValue(value);
    },
    persist: () => {
      requireRunning();
      event("persist", null, () => {
        durable = new Map(volatile);
        return null;
      });
    },
    crash: () => {
      event("crash", null, () => {
        running = false;
        volatile.clear();
        return null;
      });
    },
    restart: () => {
      event("restart", null, () => {
        running = true;
        volatile = new Map(durable);
        return null;
      });
    },
    trace: () => ({
      format: "modelt.host-tape",
      version: 1,
      events: events.map((entry) => ({
        operation: entry.operation,
        input: normalizePortableValue(entry.input),
        output: normalizePortableValue(entry.output),
      })),
    }),
    finish: () => {
      if (failed) throw new HostReplayError("Replay has diverged");
      if (source && cursor !== source.length)
        throw new HostReplayError("Replay tape has unconsumed events");
      closed = true;
    },
  };
};
