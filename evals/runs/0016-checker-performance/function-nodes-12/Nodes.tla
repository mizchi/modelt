---- MODULE Nodes ----
EXTENDS Naturals
VARIABLE nodes
Init == nodes = [node \in 1..12 |-> 0]
Next == \E node \in 1..12: nodes' = [nodes EXCEPT ![node] = 1]
Safe == nodes \in [1..12 -> 0..1]
====