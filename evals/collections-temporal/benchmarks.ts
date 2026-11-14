export const benchmarks = () => [
  {
    name: "set-delivery-12",
    states: 4096,
    source: String.raw`---- MODULE Delivery ----
EXTENDS Naturals, FiniteSets
VARIABLE delivered
Init == delivered = {}
Next == \E node \in 1..12: delivered' = delivered \cup {node}
Safe == delivered \subseteq 1..12
====`,
    config: "INIT Init\nNEXT Next\nINVARIANT Safe",
  },
  {
    name: "function-nodes-12",
    states: 4096,
    source: String.raw`---- MODULE Nodes ----
EXTENDS Naturals
VARIABLE nodes
Init == nodes = [node \in 1..12 |-> 0]
Next == \E node \in 1..12: nodes' = [nodes EXCEPT ![node] = 1]
Safe == nodes \in [1..12 -> 0..1]
====`,
    config: "INIT Init\nNEXT Next\nINVARIANT Safe",
  },
  {
    name: "sequence-queue-10",
    states: 2047,
    source: String.raw`---- MODULE Queue ----
EXTENDS Naturals, Sequences
VARIABLE queue
Init == queue = <<>>
Next == IF Len(queue) < 10 THEN \E message \in {0,1}: queue' = Append(queue,message) ELSE queue' = Tail(queue)
Safe == queue \in Seq(0..1) /\ Len(queue) <= 10
====`,
    config: "INIT Init\nNEXT Next\nINVARIANT Safe",
  },
  {
    name: "fair-ring-128",
    states: 128,
    source: String.raw`---- MODULE FairRing ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = IF x < 127 THEN x + 1 ELSE 0
Spec == Init /\ [][Next]_x /\ WF_x(Next)
P == []<>(x = 127)
====`,
    config: "SPECIFICATION Spec\nPROPERTY P",
  },
];
