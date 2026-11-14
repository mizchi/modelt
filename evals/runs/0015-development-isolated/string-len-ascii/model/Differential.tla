---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Len("abc"))
Next == UNCHANGED x
Prop == x # x
====