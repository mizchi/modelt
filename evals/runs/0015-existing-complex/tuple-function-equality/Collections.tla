---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<7, 8>>
Next == UNCHANGED x
Safe == x = [i \in 1..2 |-> i + 6]
====