import type { SafetyBounds } from "../../src/contracts.js";

export interface SafetyCase {
  readonly name: string;
  readonly source: string;
  readonly config: string;
  readonly expected: string;
  readonly bounds?: SafetyBounds;
}

export const bounds: SafetyBounds = {
  maxDepth: 100,
  maxStates: 1000,
  maxWork: 100000,
};

export const cases: readonly SafetyCase[] = [
  {
    name: "false-constant-invariant",
    source: "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == FALSE",
    expected: "error",
  },
  {
    name: "false-constant-empty",
    source: "VARIABLE x\nInit == x \\in {}\nNext == UNCHANGED x\nSafe == FALSE",
    expected: "error",
  },
  {
    name: "mixed-equality",
    source: "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == x = TRUE",
    expected: "error",
  },
  {
    name: "mixed-membership",
    source:
      "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == x \\in BOOLEAN",
    expected: "error",
  },
  {
    name: "mixed-range-membership",
    source:
      "VARIABLE x\nInit == x = TRUE\nNext == UNCHANGED x\nSafe == x \\in 0..3",
    expected: "error",
  },
  {
    name: "mixed-assignment",
    source:
      "VARIABLE x\nInit == x = 0\nNext == /\\ x' = TRUE\n        /\\ x' = 1\nSafe == TRUE",
    expected: "error",
  },
  {
    name: "strict-set-elements",
    source:
      "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == x \\in {0, 2147483647 + 1}",
    expected: "error",
  },
  {
    name: "cycle",
    source:
      "VARIABLE x\nInit == x = 0\nNext == x' = IF x < 3 THEN x + 1 ELSE 0\nSafe == x \\in 0..3",
    expected: "complete",
  },
  {
    name: "violation",
    source: "VARIABLE x\nInit == x = 0\nNext == x' = x + 1\nSafe == x < 3",
    expected: "invariant-violation",
  },
  {
    name: "initial-violation",
    source: "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == x > 0",
    expected: "invariant-violation",
  },
  {
    name: "deadlock",
    source:
      "VARIABLE x\nInit == x = 0\nNext == /\\ x < 2\n        /\\ x' = x + 1\nSafe == TRUE",
    expected: "deadlock",
  },
  {
    name: "termination",
    source:
      "VARIABLE x\nInit == x = 0\nNext == /\\ FALSE\n        /\\ UNCHANGED x\nSafe == TRUE",
    config: "CHECK_DEADLOCK FALSE",
    expected: "complete",
  },
  {
    name: "self-loop",
    source: "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == TRUE",
    expected: "complete",
  },
  {
    name: "empty",
    source:
      "VARIABLE x\nInit == /\\ x \\in {}\nNext == UNCHANGED x\nSafe == TRUE",
    expected: "empty",
  },
  {
    name: "multiple-initial",
    source:
      "VARIABLES x, y\nInit == /\\ x \\in {2, 0, 2, 1}\n        /\\ y = x\nNext == UNCHANGED <<x, y>>\nSafe == x = y",
    expected: "complete",
  },
  {
    name: "boolean",
    source:
      "VARIABLE flag\nInit == flag \\in BOOLEAN\nNext == flag' = ~flag\nSafe == flag \\in BOOLEAN",
    expected: "complete",
  },
  {
    name: "nondeterminism",
    source: "VARIABLE x\nInit == x = 0\nNext == x' \\in 0..2\nSafe == x <= 2",
    expected: "complete",
  },
  {
    name: "contradiction",
    source:
      "VARIABLE x\nInit == x = 0\nNext == /\\ x' = 1\n        /\\ x' = 2\nSafe == TRUE",
    expected: "deadlock",
  },
  {
    name: "matching-assignment",
    source:
      "VARIABLE x\nInit == x = 0\nNext == /\\ x' = 1\n        /\\ x' = 1\nSafe == TRUE",
    expected: "complete",
  },
  {
    name: "primed-read",
    source:
      "VARIABLES x, y\nInit == /\\ x = 0\n        /\\ y = 0\nNext == /\\ x' = 1\n        /\\ y' = x'\nSafe == x = y",
    expected: "complete",
  },
  {
    name: "incomplete",
    source:
      "VARIABLES x, y\nInit == /\\ x = 0\n        /\\ y = 0\nNext == x' = 1\nSafe == TRUE",
    expected: "error",
  },
  {
    name: "unassigned-read",
    source:
      "VARIABLES x, y\nInit == /\\ x = 0\n        /\\ y = 0\nNext == /\\ y' = x'\n        /\\ x' = 1\nSafe == TRUE",
    expected: "error",
  },
  {
    name: "overflow",
    source:
      "VARIABLE x\nInit == x = 2147483647\nNext == x' = x + 1\nSafe == TRUE",
    expected: "error",
  },
  {
    name: "type-error",
    source: "VARIABLE x\nInit == x = TRUE\nNext == x' = x + 1\nSafe == TRUE",
    expected: "error",
  },
  {
    name: "nonboolean-invariant",
    source: "VARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == x + 1",
    expected: "error",
  },
  {
    name: "lazy-if",
    source:
      "VARIABLE x\nInit == x = 0\nNext == x' = IF TRUE THEN 0 ELSE 2147483647 + 1\nSafe == TRUE",
    expected: "complete",
  },
  {
    name: "action-if",
    source:
      "VARIABLE x\nInit == x = 0\nNext == IF x = 0 THEN x' = 1 ELSE x' = 0\nSafe == x <= 1",
    expected: "complete",
  },
  {
    name: "scoped-parameters",
    source:
      "VARIABLES x, y\nG(z) == y + z\nF(parameter) == G(parameter)\nInit == /\\ x = 0\n        /\\ y = 2\nNext == /\\ x' = F(1)\n        /\\ UNCHANGED y\nSafe == x = 0 \\/ x = 3",
    expected: "complete",
  },
  {
    name: "assumption",
    source:
      "ASSUME FALSE\nVARIABLE x\nInit == x = 0\nNext == UNCHANGED x\nSafe == TRUE",
    expected: "assumption-violation",
  },
  {
    name: "constants",
    source:
      "CONSTANT N\nVARIABLE x\nInit == x = 0\nNext == x' = IF x < N THEN x + 1 ELSE 0\nSafe == x <= N",
    config: "CONSTANT N = 3",
    expected: "complete",
  },
  {
    name: "depth-cut",
    source:
      "VARIABLE x\nInit == x = 0\nNext == x' = IF x < 3 THEN x + 1 ELSE 0\nSafe == TRUE",
    expected: "bounded",
    bounds: { ...bounds, maxDepth: 2 },
  },
  {
    name: "closed-at-depth",
    source:
      "VARIABLE x\nInit == x = 0\nNext == x' = IF x < 3 THEN x + 1 ELSE 0\nSafe == TRUE",
    expected: "complete",
    bounds: { ...bounds, maxDepth: 3 },
  },
  {
    name: "state-cut",
    source:
      "VARIABLE x\nInit == x = 0\nNext == x' = IF x < 3 THEN x + 1 ELSE 0\nSafe == TRUE",
    expected: "bounded",
    bounds: { ...bounds, maxStates: 3 },
  },
  {
    name: "work-cut",
    source: "VARIABLE x\nInit == x = 0\nNext == x' = x + 1\nSafe == TRUE",
    expected: "bounded",
    bounds: { ...bounds, maxWork: 1 },
  },
  {
    name: "huge-choice-budget",
    source:
      "VARIABLE x\nInit == x \\in 0..2147483647\nNext == UNCHANGED x\nSafe == TRUE",
    expected: "bounded",
    bounds: { ...bounds, maxWork: 8 },
  },
].map((entry) => ({
  ...entry,
  source: `---- MODULE Test ----\nEXTENDS Naturals\n${entry.source}\n====`,
  config: `INIT Init\nNEXT Next\nINVARIANT Safe\n${entry.config ?? ""}`,
}));

export const benchmarkCases = (): readonly {
  readonly name: string;
  readonly source: string;
  readonly config: string;
  readonly states: number;
}[] => [
  ...[10000, 50000, 100000].map((states) => ({
    name: `ring-${states}`,
    states,
    source: `---- MODULE Ring ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLE x\nInit == x = 0\nNext == x' = IF x < N - 1 THEN x + 1 ELSE 0\nSafe == x \\in 0..(N - 1)\n====`,
    config: `CONSTANT N = ${states}\nINIT Init\nNEXT Next\nINVARIANT Safe`,
  })),
  ...[20, 50, 100].map((size) => ({
    name: `grid-${size}`,
    states: size * size,
    source: `---- MODULE Grid ----\nEXTENDS Naturals\nCONSTANT N\nVARIABLES x, y\nInit == /\\ x = 0\n        /\\ y = 0\nRight == /\\ x' = IF x < N - 1 THEN x + 1 ELSE 0\n         /\\ UNCHANGED y\nUp == /\\ y' = IF y < N - 1 THEN y + 1 ELSE 0\n      /\\ UNCHANGED x\nNext == Right \\/ Up\nSafe == /\\ x \\in 0..(N - 1)\n        /\\ y \\in 0..(N - 1)\n====`,
    config: `CONSTANT N = ${size}\nINIT Init\nNEXT Next\nINVARIANT Safe`,
  })),
];
