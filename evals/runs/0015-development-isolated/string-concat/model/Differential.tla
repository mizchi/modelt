---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ("ab" \o "cd")
Next == UNCHANGED x
Prop == x # x
====