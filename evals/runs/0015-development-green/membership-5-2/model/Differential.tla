---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (1 \in (-1..1))
Next == UNCHANGED x
Prop == x # x
====