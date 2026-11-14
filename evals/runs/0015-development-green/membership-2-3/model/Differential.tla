---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ("a" \in ({}))
Next == UNCHANGED x
Prop == x # x
====