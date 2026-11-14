---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = (Append("abc","d"))
Next == UNCHANGED x
Prop == x # x
====