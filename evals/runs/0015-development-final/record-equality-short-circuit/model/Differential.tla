---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([a |-> 0, b |-> TRUE] = [a |-> 1, b |-> 0])
Next == UNCHANGED x
Prop == x # x
====