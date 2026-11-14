---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (1 \in (0..0))
Next == UNCHANGED x
Prop == x # x
====