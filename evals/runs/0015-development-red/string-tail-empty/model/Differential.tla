---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Tail(""))
Next == UNCHANGED x
Prop == x # x
====