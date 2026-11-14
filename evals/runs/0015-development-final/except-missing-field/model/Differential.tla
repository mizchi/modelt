---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([ [a |-> 0] EXCEPT !.b = Head(<<>>) ])
Next == UNCHANGED x
Prop == x # x
====