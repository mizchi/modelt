---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = 0
Next == \E <<i,j>> \in {<<1,2,3>>}: x' = 0
Safe == TRUE
====