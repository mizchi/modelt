---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (\A n \in {}: Head(<<>>))
Next == UNCHANGED x
Prop == x # x
====