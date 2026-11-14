---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (TRUE \in (1..0))
Next == UNCHANGED x
Prop == x # x
====