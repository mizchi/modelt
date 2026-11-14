---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = 0
Next == (\E i \in 0..1: x' = i) /\ (\E j \in 0..1: x' = j)
Safe == x \in 0..1
====