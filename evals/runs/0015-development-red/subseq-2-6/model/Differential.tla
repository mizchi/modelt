---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq(<<7,8,9>>,2,1))
Next == UNCHANGED x
Prop == x # x
====