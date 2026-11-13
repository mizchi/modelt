import type { Driver, Model } from "../src/index.js";

export type TtlAction =
  | { readonly type: "put"; readonly ttl: number }
  | { readonly type: "advance"; readonly amount: number }
  | { readonly type: "read" };
export type TtlObservation = "ok" | "cached" | null;

interface TtlState {
  readonly now: number;
  readonly expires: number | null;
}

export const ttlModel: Model<TtlState, TtlAction, TtlObservation> = {
  name: "ttl-expiry",
  initial: () => [{ state: { now: 0, expires: null }, observation: "ok" }],
  key: (state) => JSON.stringify(state),
  actions: () => [],
  step: (state, action) => {
    if (action.type === "put")
      return [
        {
          state: { ...state, expires: state.now + action.ttl },
          observation: "ok",
        },
      ];
    if (action.type === "advance")
      return [
        {
          state: { ...state, now: state.now + action.amount },
          observation: "ok",
        },
      ];
    return [
      {
        state,
        observation:
          state.expires !== null && state.now < state.expires ? "cached" : null,
      },
    ];
  },
};

const createCache = (now: () => number, inclusiveBug: boolean) => {
  let expiresAt: number | undefined;
  return {
    put: (ttl: number) => {
      expiresAt = now() + ttl;
    },
    read: (): "cached" | null =>
      expiresAt === undefined ||
      (inclusiveBug ? now() > expiresAt : now() >= expiresAt)
        ? null
        : "cached",
  };
};

export const createTtlDriver = (
  inclusiveBug: boolean,
): Driver<TtlAction, TtlObservation> => {
  let clock = 0;
  let cache = createCache(() => clock, inclusiveBug);
  return {
    reset: () => {
      clock = 0;
      cache = createCache(() => clock, inclusiveBug);
      return "ok";
    },
    step: (action) => {
      if (action.type === "put") {
        cache.put(action.ttl);
        return "ok";
      }
      if (action.type === "advance") {
        clock += action.amount;
        return "ok";
      }
      return cache.read();
    },
  };
};
