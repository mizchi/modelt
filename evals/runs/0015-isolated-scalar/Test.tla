---- MODULE Test ----
EXTENDS Naturals
CONSTANT N
VARIABLE x
Init == x = 0
Next == x' = IF x < N THEN x + 1 ELSE 0
Safe == x <= N
====