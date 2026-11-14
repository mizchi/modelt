---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (<<>> \in Seq({}))
Next == UNCHANGED x
Prop == x # x
====