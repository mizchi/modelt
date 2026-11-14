---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([ <<[a |-> 0]>> EXCEPT ![1].a = @+1, ![1].a = @+1 ])
Next == UNCHANGED x
Prop == x # x
====