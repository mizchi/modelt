---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Tail("a😀"))
Next == UNCHANGED x
Prop == x # x
====