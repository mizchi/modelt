import { readFileSync } from "node:fs";
import type { SafetyBounds, SafetyResult } from "../../src/contracts.js";
export interface Case {
  readonly name: string;
  readonly source: string;
  readonly config: string;
  readonly expected: SafetyResult["status"] | "error";
  readonly bounds?: SafetyBounds;
}
export const bounds: SafetyBounds = {
  maxDepth: 1000,
  maxStates: 10000,
  maxWork: 2000000,
  maxTemporalNodes: 50000,
};
const state = (
  name: string,
  init: string,
  next: string,
  invariant: string,
  expected: Case["expected"] = "complete",
): Case => ({
  name,
  source: `---- MODULE Collections ----\nEXTENDS Integers, Sequences, FiniteSets\nVARIABLE x\nInit == x = ${init}\nNext == ${next}\nSafe == ${invariant}\n====`,
  config: "INIT Init\nNEXT Next\nINVARIANT Safe\nCHECK_DEADLOCK FALSE",
  expected,
});
const toggle = (
  name: string,
  property: string,
  fairness = "",
  expected: Case["expected"] = "complete",
): Case => ({
  name,
  source: `---- MODULE Toggle ----\nEXTENDS Naturals\nVARIABLE x\nInit == x = 0\nNext == x' = 1 - x\nSpec == Init /\\ [][Next]_x ${fairness}\nProp == ${property}\n====`,
  config: "SPECIFICATION Spec\nPROPERTY Prop",
  expected,
});
const intermittent = (kind: "WF" | "SF"): Case => ({
  name: `${kind}-intermittent`,
  source:
    String.raw`---- MODULE Intermittent ----
EXTENDS Naturals
VARIABLE x, done
Init == /\ x = 0 /\ done = FALSE
Tick == /\ x' = 1 - x /\ UNCHANGED done
Finish == /\ x = 0 /\ done' = TRUE /\ UNCHANGED x
Next == Tick \/ Finish
Spec == Init /\ [][Next]_<<x, done>> /\ WF_<<x, done>>(Tick) /\ ` +
    `${kind}_<<x, done>>(Finish)\nProp == <>done\n====`,
  config: "SPECIFICATION Spec\nPROPERTY Prop",
  expected: kind === "SF" ? "complete" : "liveness-violation",
});
export const cases: readonly Case[] = [
  state(
    "set-delivery",
    "{}",
    String.raw`\E n \in 1..3: x' = x \cup {n}`,
    String.raw`x \subseteq 1..3 /\ Cardinality(x) <= 3`,
  ),
  state(
    "set-fault",
    "{}",
    String.raw`\E n \in 1..3: x' = x \cup {n}`,
    "Cardinality(x) < 2",
    "invariant-violation",
  ),
  state(
    "tuple-function-equality",
    "<<7, 8>>",
    "UNCHANGED x",
    String.raw`x = [i \in 1..2 |-> i + 6]`,
  ),
  state(
    "record-function-equality",
    "[a |-> 1, b |-> 2]",
    "UNCHANGED x",
    String.raw`x = [i \in {"a", "b"} |-> IF i = "a" THEN 1 ELSE 2]`,
  ),
  state(
    "function-updates",
    String.raw`[i \in 1..3 |-> 0]`,
    String.raw`\E n \in 1..3: x' = [x EXCEPT ![n] = 1]`,
    String.raw`x \in [1..3 -> 0..1] /\ \A n \in 1..3: x[n] <= 1`,
  ),
  state(
    "record-updates",
    "[a |-> <<0>>, b |-> {1}]",
    "x' = [x EXCEPT !.a[1] = 1 - @]",
    String.raw`x \in [a: Seq(0..1), b: SUBSET (1..2)]`,
  ),
  state(
    "except-sequential-at",
    "<<0>>",
    "x' = [x EXCEPT ![1] = @ + 1, ![1] = @ + 1]",
    "x[1] < 2",
    "invariant-violation",
  ),
  state(
    "except-missing-skips-rhs",
    "<<0>>",
    "x' = [x EXCEPT ![2] = Head(<<>>)]",
    "x = <<0>>",
  ),
  state(
    "sequence-queue",
    "<<>>",
    String.raw`IF Len(x) < 3 THEN \E n \in {0,1}: x' = Append(x,n) ELSE x' = Tail(x)`,
    String.raw`x \in Seq(0..1) /\ Len(x) <= 3`,
  ),
  state(
    "sequence-concat-subseq",
    "<<1,2,3>>",
    String.raw`x' = SubSeq(x,2,Len(x)) \o <<Head(x)>>`,
    "Len(x) = 3",
  ),
  state(
    "filter-map-powerset",
    String.raw`{n + 1: n \in {i \in 0..3: i < 2}}`,
    "UNCHANGED x",
    String.raw`x = {1,2} /\ x \in SUBSET (1..3) /\ UNION {x,{3}} = 1..3 /\ x \cap {2,3} = {2} /\ x \ {2} = {1}`,
  ),
  state(
    "function-set-enumeration",
    "[1..2 -> 0..1]",
    "UNCHANGED x",
    "Cardinality(x) = 4",
  ),
  state(
    "record-set-enumeration",
    "[a: {0,1}, b: {TRUE,FALSE}]",
    "UNCHANGED x",
    "Cardinality(x) = 4",
  ),
  state(
    "empty-function-domain",
    "[{} -> {}]",
    "UNCHANGED x",
    String.raw`x = {<<>>} /\ [i \in {} |-> 1] = <<>>`,
  ),
  state(
    "function-multi-argument",
    String.raw`[i \in 1..2, j \in 1..2 |-> i+j]`,
    "UNCHANGED x",
    "x[1,2] = 3",
  ),
  state(
    "tuple-pattern",
    "0",
    String.raw`\E <<i,j>> \in {<<1,2>>, <<2,1>>}: x' = i+j`,
    String.raw`x \in {0,3}`,
  ),
  state(
    "independent-existentials",
    "0",
    String.raw`(\E i \in 0..1: x' = i) /\ (\E j \in 0..1: x' = j)`,
    String.raw`x \in 0..1`,
  ),
  state(
    "let-lexical-scope",
    "0",
    String.raw`\E i \in 0..1: LET Inc(a) == a + i IN x' = Inc(1)`,
    String.raw`x \in {0,1,2}`,
  ),
  state(
    "invalid-tuple-pattern-arity",
    "0",
    String.raw`\E <<i,j>> \in {<<1,2,3>>}: x' = 0`,
    "TRUE",
    "error",
  ),
  state(
    "invalid-sequence-membership",
    "1",
    "UNCHANGED x",
    String.raw`x \in Seq(0..1)`,
    "error",
  ),
  state(
    "invalid-sequence-domain",
    "[a |-> 1]",
    "UNCHANGED x",
    String.raw`x \in Seq(0..1)`,
    "error",
  ),
  state("invalid-sequence-index", "<<1>>", "x' = <<x[0]>>", "TRUE", "error"),
  state("invalid-head", "<<>>", "x' = <<Head(x)>>", "TRUE", "error"),
  state("invalid-tail", "<<>>", "x' = Tail(x)", "TRUE", "error"),
  state("mixed-set-types", "{1,TRUE}", "UNCHANGED x", "TRUE", "error"),
  {
    ...state(
      "collection-work-cut",
      "SUBSET (1..30)",
      "UNCHANGED x",
      "TRUE",
      "bounded",
    ),
    bounds: { ...bounds, maxWork: 1000 },
  },
  state(
    "function-domain-before-range",
    "{[i \u005cin {1} |-> TRUE], [i \u005cin {2} |-> 0]}",
    "UNCHANGED x",
    "Cardinality(x) = 2",
  ),
  toggle("initial-property-failure", "x = 1", "", "property-violation"),
  toggle(
    "initial-property-boolean",
    "x = 0 /\\ x = 1",
    "",
    "property-violation",
  ),
  toggle(
    "initial-property-implication",
    "x = 0 => x = 1",
    "",
    "property-violation",
  ),
  toggle("action-property", "[]([x' = x]_x)", "", "property-violation"),
  {
    name: "upstream-channel",
    source: readFileSync("evals/fixtures/channel/Channel.tla", "utf8"),
    config:
      'SPECIFICATION Spec\nCONSTANT Data = {"a", "b"}\nINVARIANT TypeInvariant',
    expected: "complete",
  },
  toggle("initial-property-only", "x = 0"),
  toggle("always-state", "[](x = 0)", "", "invariant-violation"),
  toggle("eventually-stuttering", "<>(x = 1)", "", "liveness-violation"),
  toggle("eventually-WF", "<>(x = 1)", String.raw`/\ WF_x(Next)`),
  toggle("always-eventually-WF", "[]<>(x = 1)", String.raw`/\ WF_x(Next)`),
  toggle(
    "eventually-always-WF",
    "<>[](x = 1)",
    String.raw`/\ WF_x(Next)`,
    "liveness-violation",
  ),
  toggle("leads-to-WF", "(x = 0) ~> (x = 1)", String.raw`/\ WF_x(Next)`),
  toggle(
    "multiple-eventualities",
    "<>[](x = 0) \\/ <>[](x = 1)",
    String.raw`/\ WF_x(Next)`,
    "liveness-violation",
  ),
  toggle(
    "temporal-negation",
    "~([]<>(x = 0))",
    String.raw`/\ WF_x(Next)`,
    "liveness-violation",
  ),
  intermittent("WF"),
  intermittent("SF"),
  {
    ...toggle("temporal-node-cut", "<>(x = 1)", "", "bounded"),
    bounds: { ...bounds, maxTemporalNodes: 1 },
  },
  {
    name: "terminal-stuttering",
    source:
      "---- MODULE Terminal ----\nVARIABLE x\nInit == x = FALSE\nNext == x /\\ UNCHANGED x\nP == <>x\n====",
    config: "INIT Init\nNEXT Next\nPROPERTY P\nCHECK_DEADLOCK FALSE",
    expected: "liveness-violation",
  },
  {
    name: "deadlock-before-temporal",
    source:
      "---- MODULE Terminal ----\nVARIABLE x\nInit == x = FALSE\nNext == x /\\ UNCHANGED x\nP == <>x\n====",
    config: "INIT Init\nNEXT Next\nPROPERTY P",
    expected: "deadlock",
  },
  {
    name: "multiple-initial-temporal",
    source:
      "---- MODULE Roots ----\nEXTENDS Naturals\nVARIABLE x\nInit == x \\in {0,1}\nNext == UNCHANGED x\nP == <>(x=1)\n====",
    config: "INIT Init\nNEXT Next\nPROPERTY P",
    expected: "liveness-violation",
  },
  {
    name: "empty-before-temporal",
    source:
      "---- MODULE Empty ----\nVARIABLE x\nInit == x \\in {}\nNext == UNCHANGED x\nP == <>x\n====",
    config: "INIT Init\nNEXT Next\nPROPERTY P",
    expected: "empty",
  },
  {
    ...state("growing-state-nesting", "0", "x' = <<x>>", "TRUE", "error"),
    bounds: { ...bounds, maxStates: 200 },
  },
];
