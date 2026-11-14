---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (\E n \in {}: Head(<<>>))
Next == UNCHANGED x
Prop == x # x
====