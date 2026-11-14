---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (<<1>> \in [2..3 -> Head(<<>>)])
Next == UNCHANGED x
Prop == x # x
====