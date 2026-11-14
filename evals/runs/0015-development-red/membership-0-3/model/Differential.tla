---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (TRUE \in ({}))
Next == UNCHANGED x
Prop == x # x
====