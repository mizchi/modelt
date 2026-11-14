---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([a |-> TRUE] \in [b: {0}])
Next == UNCHANGED x
Prop == x # x
====