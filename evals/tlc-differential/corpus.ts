export interface Input {
  readonly name: string;
  readonly family: "value" | "graph" | "control";
  readonly source: string;
  readonly config: string;
  readonly seed?: number;
}
export const seeds = { development: 0x15a1, confirmation: 0x15b2 } as const;
const value = (name: string, expression: string): Input => ({
  name,
  family: "value",
  source: `---- MODULE Differential ----\nEXTENDS Integers, Sequences, FiniteSets\nVARIABLE x\nInit == x = (${expression})\nNext == UNCHANGED x\nProp == x # x\n====`,
  config: "INIT Init\nNEXT Next\nINVARIANT Prop\nCHECK_DEADLOCK FALSE",
});
export const boundaries = (): readonly Input[] => [
  ...["<<>>", "<<7>>", "<<7,8,9>>"].flatMap((sequence, size) =>
    [
      [-1, -1],
      [0, -1],
      [0, 0],
      [1, 0],
      [1, 1],
      [1, 3],
      [2, 1],
      [3, 4],
    ].map(([from, to], index) =>
      value(`subseq-${size}-${index}`, `SubSeq(${sequence},${from},${to})`),
    ),
  ),
  ...["TRUE", "FALSE", '"a"', "-1", "0", "1"].flatMap((entry, index) =>
    ["1..0", "0..0", "-1..1", "{}"].map((domain, range) =>
      value(`membership-${index}-${range}`, `${entry} \\in (${domain})`),
    ),
  ),
  ...[
    ["subset-short-circuit", "{{}, {TRUE}} \\subseteq {{0}}"],
    ["subset-short-circuit-negated", "~({{}, {TRUE}} \\subseteq {{0}})"],
    ["subset-empty", "{} \\subseteq 0"],
    ["cap-empty", "{} \\cap 0"],
    ["difference-empty", "{} \\ 0"],
    ["function-empty-range-error", "<<>> \\in [{} -> Head(<<>>)]"],
    ["function-domain-range-error", "<<1>> \\in [2..3 -> Head(<<>>)]"],
    ["record-domain-range-error", "[a |-> 1] \\in [b: Head(<<>>)]"],
    ["record-later-field-error", "[a |-> 1] \\in [a: {}, b: Head(<<>>)]"],
    ["nested-seq-membership", "[a |-> <<0,1>>] \\in [a: Seq(0..1)]"],
    ["nested-function-membership", "[a |-> <<0,1>>] \\in [a: [1..2 -> 0..1]]"],
    ["empty-seq-range", "<<>> \\in Seq({})"],
    ["seq-range-error", "<<>> \\in Seq(Head(<<>>))"],
    ["record-domain-mismatch", "[a |-> TRUE] \\in [b: {0}]"],
    ["function-domain-mismatch", "<<TRUE>> \\in [2..3 -> 0..1]"],
    ["record-equality-domain", "[a |-> TRUE] = [b |-> 1]"],
    [
      "record-equality-short-circuit",
      "[a |-> 0, b |-> TRUE] = [a |-> 1, b |-> 0]",
    ],
    ["except-missing-field", "[ [a |-> 0] EXCEPT !.b = Head(<<>>) ]"],
    [
      "except-nested-old",
      "[ <<[a |-> 0]>> EXCEPT ![1].a = @+1, ![1].a = @+1 ]",
    ],
    ["string-len-empty", 'Len("")'],
    ["string-len-ascii", 'Len("abc")'],
    ["string-len-supplementary", 'Len("😀")'],
    ["string-tail", 'Tail("abc")'],
    ["string-tail-prefix", 'Tail("a😀")'],
    ["string-tail-empty", 'Tail("")'],
    ["string-head-error", 'Head("abc")'],
    ["string-append-error", 'Append("abc","d")'],
    ["string-concat", '"ab" \\o "cd"'],
    ["string-subseq", 'SubSeq("abc",2,3)'],
    ["string-subseq-empty", 'SubSeq("abc",2,1)'],
    ["empty-quantifier", "\\A n \\in {}: Head(<<>>)"],
    ["empty-existential", "\\E n \\in {}: Head(<<>>)"],
    [
      "quantifier-short-circuit",
      "\\E n \\in 0..1: IF n = 0 THEN TRUE ELSE Head(<<>>)",
    ],
  ].map(([name, expression]) => value(name ?? "", expression ?? "")),
  {
    name: "positive-control",
    family: "control",
    source:
      "---- MODULE Differential ----\nVARIABLE x\nInit == x = TRUE\nNext == UNCHANGED x\nProp == x\n====",
    config: "INIT Init\nNEXT Next\nINVARIANT Prop",
  },
  {
    name: "error-control",
    family: "control",
    source:
      "---- MODULE Differential ----\nEXTENDS Sequences\nVARIABLE x\nInit == x = Head(<<>>)\nNext == UNCHANGED x\n====",
    config: "INIT Init\nNEXT Next",
  },
];
export const graphs = (seed: number): readonly Input[] => {
  let state = seed;
  const pick = (maximum: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % maximum;
  };
  return Array.from({ length: 32 }, (_, index) => {
    const nodes = 2 + pick(3);
    const edges = [
      [0, 1],
      ...Array.from({ length: pick(nodes * 2) + 1 }, () => [
        pick(nodes),
        pick(nodes),
      ]),
    ];
    const actions = edges
      .map(([from, to], edge) => `A${edge} == x = ${from} /\\ x' = ${to}`)
      .join("\n");
    const target = pick(nodes);
    const predicates = [
      `[](x < ${nodes})`,
      `<>(x = ${target})`,
      `[]<>(x = ${target})`,
      `<>[](x = ${target})`,
      `(x = 0) ~> (x = ${target})`,
      `<>[](x = 0) \\/ <>[](x = ${target})`,
      `~([]<>(x = ${target}))`,
      `([]<>(x = 0)) /\\ ([]<>(x = ${target}))`,
    ];
    const fairness = [
      "",
      " /\\ WF_x(Next)",
      " /\\ SF_x(A0)",
      " /\\ WF_x(Next) /\\ SF_x(A0)",
    ][Math.floor(index / 8)];
    return {
      name: `graph-${seed.toString(16)}-${index}`,
      family: "graph",
      seed,
      source: `---- MODULE Differential ----\nEXTENDS Naturals\nVARIABLE x\nInit == x \\in ${index % 3 === 0 ? "{0,1}" : "{0}"}\n${actions}\nNext == ${edges.map((_, edge) => `A${edge}`).join(" \\/ ")}\nSpec == Init /\\ [][Next]_x${fairness}\nProp == ${predicates[index % 8]}\n====`,
      config: `SPECIFICATION Spec\nPROPERTY Prop\nCHECK_DEADLOCK ${index % 2 === 0 ? "FALSE" : "TRUE"}`,
    };
  });
};
export const corpus = (
  phase: "development" | "confirmation",
): readonly Input[] => [
  ...(phase === "development" ? boundaries() : []),
  ...graphs(seeds[phase]),
];
