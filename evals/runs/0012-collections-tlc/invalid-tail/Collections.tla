---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<>>
Next == x' = Tail(x)
Safe == TRUE
====