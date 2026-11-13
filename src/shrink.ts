import type {
  ActionDependency,
  DeletionRange,
  ShrinkResult,
  ShrinkVerdict,
} from "./contracts.js";

export type {
  ActionDependency,
  DeletionRange,
  ShrinkResult,
  ShrinkVerdict,
} from "./contracts.js";

export const deletionCandidates = (
  length: number,
): readonly DeletionRange[] => {
  if (!Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff)
    throw new RangeError("Invalid sequence length");
  const ranges: DeletionRange[] = [];
  const seen = new Set<string>();
  for (
    let size = length;
    size >= 1;
    size = size === 1 ? 0 : Math.ceil(size / 2)
  )
    for (let start = 0; start < length; start += size) {
      const count = Math.min(size, length - start);
      const key = `${start}:${count}`;
      if (!seen.has(key)) {
        seen.add(key);
        ranges.push({ start, count });
      }
    }
  return ranges;
};

export const shrinkCounterexample = async <Action>(
  actions: readonly Action[],
  evaluate: (actions: readonly Action[]) => Promise<ShrinkVerdict>,
  options: {
    readonly maxChecks: number;
    readonly candidates?: (length: number) => readonly DeletionRange[];
    readonly isEnabled?: (actions: readonly Action[]) => boolean;
    readonly dependencies?: (
      actions: readonly Action[],
    ) => readonly ActionDependency[];
  },
): Promise<ShrinkResult<Action>> => {
  if (!Number.isSafeInteger(options.maxChecks) || options.maxChecks < 2)
    throw new RangeError("Shrinking requires at least two checks");
  if (options.isEnabled && !options.isEnabled(actions))
    throw new Error("Initial counterexample is not enabled");
  const baseline = await evaluate(actions);
  if (baseline.status !== "mismatch")
    return { status: "not-failing", actions: [...actions], checks: 1 };
  if (!baseline.signature) throw new Error("A failure signature is required");
  let current = [...actions];
  let checks = 1;
  let minimal = false;
  while (!minimal && checks + 1 < options.maxChecks) {
    let reduced = false;
    let exhausted = true;
    const ranges = (options.candidates ?? deletionCandidates)(current.length);
    if (
      new Set(
        ranges.filter((range) => range.count === 1).map((range) => range.start),
      ).size !== current.length
    )
      throw new Error("Candidates must cover every single deletion");
    const dependencies = [...(options.dependencies?.(current) ?? [])].sort(
      (left, right) => left.consumer - right.consumer,
    );
    if (
      dependencies.some(
        (entry) =>
          !Number.isSafeInteger(entry.producer) ||
          !Number.isSafeInteger(entry.consumer) ||
          entry.producer < 0 ||
          entry.consumer >= current.length ||
          entry.producer >= entry.consumer,
      )
    )
      throw new Error("Dependencies must reference an earlier producer");
    const seen = new Set<string>();
    search: for (const range of ranges) {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.count) ||
        range.start < 0 ||
        range.count < 1 ||
        range.start + range.count > current.length
      )
        throw new Error("Invalid deletion candidate");
      const removed = new Set(
        Array.from({ length: range.count }, (_, index) => range.start + index),
      );
      const closed = new Set(removed);
      for (const dependency of dependencies)
        if (closed.has(dependency.producer)) closed.add(dependency.consumer);
      for (const indices of [closed, removed]) {
        const key = [...indices].sort((left, right) => left - right).join();
        if (seen.has(key)) continue;
        seen.add(key);
        const candidate = current.filter((_, index) => !indices.has(index));
        if (options.isEnabled && !options.isEnabled(candidate)) continue;
        if (checks + 1 >= options.maxChecks) {
          exhausted = false;
          break search;
        }
        const result = await evaluate(candidate);
        checks++;
        if (
          result.status === "mismatch" &&
          result.signature === baseline.signature
        ) {
          current = candidate;
          reduced = true;
          break search;
        }
      }
    }
    minimal = !reduced && exhausted;
  }
  if (current.length === 0) minimal = true;
  if (options.isEnabled && !options.isEnabled(current))
    throw new Error("Shrunk counterexample is not enabled");
  const confirmation = await evaluate(current);
  checks++;
  if (
    confirmation.status !== "mismatch" ||
    confirmation.signature !== baseline.signature
  )
    throw new Error("Shrunk counterexample did not reproduce");
  return { status: minimal ? "minimal" : "bounded", actions: current, checks };
};
