---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [1..2 -> 0..1]
Next == UNCHANGED x
Safe == Cardinality(x) = 4
====