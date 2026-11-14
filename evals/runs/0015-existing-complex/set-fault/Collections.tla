---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = {}
Next == \E n \in 1..3: x' = x \cup {n}
Safe == Cardinality(x) < 2
====