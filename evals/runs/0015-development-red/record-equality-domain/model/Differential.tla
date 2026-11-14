---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([a |-> TRUE] = [b |-> 1])
Next == UNCHANGED x
Prop == x # x
====