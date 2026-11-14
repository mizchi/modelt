---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<0>>
Next == x' = [x EXCEPT ![1] = @ + 1, ![1] = @ + 1]
Safe == x[1] < 2
====