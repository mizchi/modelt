---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (1 \in ({}))
Next == UNCHANGED x
Prop == x # x
====