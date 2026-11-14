---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq(<<7,8,9>>,3,4))
Next == UNCHANGED x
Prop == x # x
====