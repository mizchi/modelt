---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<0>>
Next == x' = [x EXCEPT ![2] = Head(<<>>)]
Safe == x = <<0>>
====