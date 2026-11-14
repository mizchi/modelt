---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [a |-> <<0>>, b |-> {1}]
Next == x' = [x EXCEPT !.a[1] = 1 - @]
Safe == x \in [a: Seq(0..1), b: SUBSET (1..2)]
====