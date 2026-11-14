---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [i \in 1..3 |-> 0]
Next == \E n \in 1..3: x' = [x EXCEPT ![n] = 1]
Safe == x \in [1..3 -> 0..1] /\ \A n \in 1..3: x[n] <= 1
====