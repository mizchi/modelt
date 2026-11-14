---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([a |-> 1] \in [a: {}, b: Head(<<>>)])
Next == UNCHANGED x
Prop == x # x
====