---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = 0
Next == \E i \in 0..1: LET Inc(a) == a + i IN x' = Inc(1)
Safe == x \in {0,1,2}
====