---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq("abc",2,3))
Next == UNCHANGED x
Prop == x # x
====