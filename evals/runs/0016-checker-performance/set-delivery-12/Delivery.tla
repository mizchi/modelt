---- MODULE Delivery ----
EXTENDS Naturals, FiniteSets
VARIABLE delivered
Init == delivered = {}
Next == \E node \in 1..12: delivered' = delivered \cup {node}
Safe == delivered \subseteq 1..12
====