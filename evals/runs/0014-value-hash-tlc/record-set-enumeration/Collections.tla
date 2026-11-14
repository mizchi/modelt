---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = [a: {0,1}, b: {TRUE,FALSE}]
Next == UNCHANGED x
Safe == Cardinality(x) = 4
====