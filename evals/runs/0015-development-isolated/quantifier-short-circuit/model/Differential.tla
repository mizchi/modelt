---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (\E n \in 0..1: IF n = 0 THEN TRUE ELSE Head(<<>>))
Next == UNCHANGED x
Prop == x # x
====