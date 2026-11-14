---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Head("abc"))
Next == UNCHANGED x
Prop == x # x
====