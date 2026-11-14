---- MODULE Ring ----
EXTENDS Naturals
CONSTANT N
VARIABLE x
Init == x = 0
Next == x' = IF x < N - 1 THEN x + 1 ELSE 0
Safe == x \in 0..(N - 1)
====