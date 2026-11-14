---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Tail("abc"))
Next == UNCHANGED x
Prop == x # x
====