---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = 1
Next == UNCHANGED x
Safe == x \in Seq(0..1)
====