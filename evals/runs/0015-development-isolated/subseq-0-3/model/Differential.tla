---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (SubSeq(<<>>,1,0))
Next == UNCHANGED x
Prop == x # x
====