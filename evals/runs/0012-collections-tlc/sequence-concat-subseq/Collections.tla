---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<1,2,3>>
Next == x' = SubSeq(x,2,Len(x)) \o <<Head(x)>>
Safe == Len(x) = 3
====