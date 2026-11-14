---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<1>>
Next == x' = <<x[0]>>
Safe == TRUE
====