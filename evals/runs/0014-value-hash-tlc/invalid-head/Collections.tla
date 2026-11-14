---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<>>
Next == x' = <<Head(x)>>
Safe == TRUE
====