---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq(<<7>>,2,1))
Next == UNCHANGED x
Prop == x # x
====