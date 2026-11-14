---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = {n + 1: n \in {i \in 0..3: i < 2}}
Next == UNCHANGED x
Safe == x = {1,2} /\ x \in SUBSET (1..3) /\ UNION {x,{3}} = 1..3 /\ x \cap {2,3} = {2} /\ x \ {2} = {1}
====