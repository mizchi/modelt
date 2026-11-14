---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = 0
Next == \E <<i,j>> \in {<<1,2>>, <<2,1>>}: x' = i+j
Safe == x \in {0,3}
====