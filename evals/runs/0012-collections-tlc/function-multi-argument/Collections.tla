---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [i \in 1..2, j \in 1..2 |-> i+j]
Next == UNCHANGED x
Safe == x[1,2] = 3
====