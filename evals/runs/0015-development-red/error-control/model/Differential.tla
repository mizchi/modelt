---- MODULE Differential ----
EXTENDS Sequences
VARIABLE x
Init == x = Head(<<>>)
Next == UNCHANGED x
====