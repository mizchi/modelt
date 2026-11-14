---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([a |-> <<0,1>>] \in [a: [1..2 -> 0..1]])
Next == UNCHANGED x
Prop == x # x
====