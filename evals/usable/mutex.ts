import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { build } from "esbuild";
import type { Driver, Model } from "../../src/contracts.js";
import { isRecord } from "../../src/trace.js";

export type MutexAction =
  | { readonly type: "acquire"; readonly id: string }
  | { readonly type: "release" };
interface MutexState {
  readonly owner: string | null;
  readonly waiting: readonly string[];
  readonly seen: readonly string[];
  readonly granted: readonly string[];
}
export interface MutexObservation {
  readonly locked: boolean;
  readonly granted: readonly string[];
}
interface MutexPort {
  readonly acquire: () => Promise<unknown>;
  readonly release: () => void;
  readonly isLocked: () => boolean;
}
const observation = (state: MutexState): MutexObservation => ({
  locked: state.owner !== null,
  granted: state.granted,
});
export const mutexModel: Model<MutexState, MutexAction, MutexObservation> = {
  name: "fifo-mutex",
  initial: () => [
    {
      state: { owner: null, waiting: [], seen: [], granted: [] },
      observation: { locked: false, granted: [] },
    },
  ],
  key: (state) => JSON.stringify(state),
  actions: (state) => [
    { type: "release" },
    ...["a", "b", "c"]
      .filter((id) => !state.seen.includes(id))
      .map((id) => ({ type: "acquire" as const, id })),
  ],
  step: (state, action) => {
    if (action.type === "acquire") {
      if (
        state.seen.includes(action.id) ||
        !["a", "b", "c"].includes(action.id)
      )
        return [];
      const next =
        state.owner === null
          ? {
              ...state,
              owner: action.id,
              seen: [...state.seen, action.id],
              granted: [...state.granted, action.id],
            }
          : {
              ...state,
              seen: [...state.seen, action.id],
              waiting: [...state.waiting, action.id],
            };
      return [{ state: next, observation: observation(next) }];
    }
    const owner = state.waiting[0] ?? null;
    const next = {
      ...state,
      owner,
      waiting: state.waiting.slice(1),
      granted: owner === null ? state.granted : [...state.granted, owner],
    };
    return [{ state: next, observation: observation(next) }];
  },
  invariants: [
    {
      name: "exclusive-owner",
      check: (state) =>
        state.owner === null || !state.waiting.includes(state.owner),
    },
  ],
};

export const isMutexAction = (value: unknown): value is MutexAction =>
  isRecord(value) &&
  (value.type === "release" ||
    (value.type === "acquire" && typeof value.id === "string"));
const isMutex = (value: unknown): value is MutexPort =>
  isRecord(value) &&
  typeof value.acquire === "function" &&
  typeof value.release === "function" &&
  typeof value.isLocked === "function";

export const loadMutex = async (
  revision: "before" | "after",
): Promise<() => MutexPort> => {
  const root = "evals/fixtures/async-mutex";
  const provenance = JSON.parse(
    await readFile(join(root, "provenance.json"), "utf8"),
  );
  for (const file of provenance.files) {
    const actual = createHash("sha256")
      .update(await readFile(join(root, file.path)))
      .digest("hex");
    if (actual !== file.sha256) throw new Error("Upstream fixture changed");
  }
  const compiled = await build({
    entryPoints: [join(root, revision, "Mutex.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
  });
  const output = compiled.outputFiles[0];
  if (!output) throw new Error("Missing upstream bundle");
  const module: unknown = await import(
    `data:text/javascript;base64,${Buffer.from(output.contents).toString("base64")}`
  );
  if (!isRecord(module) || typeof module.default !== "function")
    throw new Error("Invalid upstream constructor");
  const mutexConstructor = module.default;
  return () => {
    const instance: unknown = Reflect.construct(mutexConstructor, []);
    if (!isMutex(instance)) throw new Error("Invalid upstream mutex");
    return instance;
  };
};

export const createMutexDriver = (
  factory: () => MutexPort,
): Driver<MutexAction, MutexObservation> => {
  let mutex = factory();
  let granted: string[] = [];
  let disposed = false;
  return {
    reset: () => {
      mutex = factory();
      granted = [];
      disposed = false;
      return { locked: false, granted: [] };
    },
    step: async (action) => {
      if (action.type === "acquire")
        void mutex.acquire().then(() => {
          if (!disposed) granted.push(action.id);
        });
      else mutex.release();
      await setImmediate();
      return { locked: mutex.isLocked(), granted: [...granted] };
    },
    dispose: () => {
      disposed = true;
    },
  };
};

export const mutexRegression: readonly MutexAction[] = [
  { type: "acquire", id: "a" },
  { type: "acquire", id: "b" },
  { type: "acquire", id: "c" },
  { type: "release" },
  { type: "release" },
];
