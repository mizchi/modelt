---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ("a" \in (0..0))
Next == UNCHANGED x
Prop == x # x
====