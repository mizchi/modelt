---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (0 \in ({}))
Next == UNCHANGED x
Prop == x # x
====