---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<>>
Next == IF Len(x) < 3 THEN \E n \in {0,1}: x' = Append(x,n) ELSE x' = Tail(x)
Safe == x \in Seq(0..1) /\ Len(x) <= 3
====