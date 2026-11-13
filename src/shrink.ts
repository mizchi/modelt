import type {
  DeletionRange,
  ShrinkResult,
  ShrinkVerdict,
} from "./contracts.js";

export type {
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
  },
): Promise<ShrinkResult<Action>> => {
  if (!Number.isSafeInteger(options.maxChecks) || options.maxChecks < 2)
    throw new RangeError("Shrinking requires at least two checks");
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
    for (const range of ranges) {
      if (
        !Number.isSafeInteger(range.start) ||
        !Number.isSafeInteger(range.count) ||
        range.start < 0 ||
        range.count < 1 ||
        range.start + range.count > current.length
      )
        throw new Error("Invalid deletion candidate");
      if (checks + 1 >= options.maxChecks) {
        exhausted = false;
        break;
      }
      const candidate = [
        ...current.slice(0, range.start),
        ...current.slice(range.start + range.count),
      ];
      const result = await evaluate(candidate);
      checks++;
      if (
        result.status === "mismatch" &&
        result.signature === baseline.signature
      ) {
        current = candidate;
        reduced = true;
        break;
      }
    }
    minimal = !reduced && exhausted;
  }
  if (current.length === 0) minimal = true;
  const confirmation = await evaluate(current);
  checks++;
  if (
    confirmation.status !== "mismatch" ||
    confirmation.signature !== baseline.signature
  )
    throw new Error("Shrunk counterexample did not reproduce");
  return { status: minimal ? "minimal" : "bounded", actions: current, checks };
};
