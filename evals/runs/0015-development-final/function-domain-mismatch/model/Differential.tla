---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (<<TRUE>> \in [2..3 -> 0..1])
Next == UNCHANGED x
Prop == x # x
====