---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = {1,TRUE}
Next == UNCHANGED x
Safe == TRUE
====