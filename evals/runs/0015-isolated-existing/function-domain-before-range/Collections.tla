---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = {[i \in {1} |-> TRUE], [i \in {2} |-> 0]}
Next == UNCHANGED x
Safe == Cardinality(x) = 2
====