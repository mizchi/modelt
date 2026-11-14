---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ({} \ 0)
Next == UNCHANGED x
Prop == x # x
====