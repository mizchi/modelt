---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [a |-> 1, b |-> 2]
Next == UNCHANGED x
Safe == x = [i \in {"a", "b"} |-> IF i = "a" THEN 1 ELSE 2]
====