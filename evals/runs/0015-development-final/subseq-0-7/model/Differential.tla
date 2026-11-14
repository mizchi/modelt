---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq(<<>>,3,4))
Next == UNCHANGED x
Prop == x # x
====