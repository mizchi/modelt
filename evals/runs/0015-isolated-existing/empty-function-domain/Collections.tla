---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [{} -> {}]
Next == UNCHANGED x
Safe == x = {<<>>} /\ [i \in {} |-> 1] = <<>>
====