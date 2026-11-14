---- MODULE Grid ----
EXTENDS Naturals
CONSTANT N
VARIABLES x, y
Init == /\ x = 0
        /\ y = 0
Right == /\ x' = IF x < N - 1 THEN x + 1 ELSE 0
         /\ UNCHANGED y
Up == /\ y' = IF y < N - 1 THEN y + 1 ELSE 0
      /\ UNCHANGED x
Next == Right \/ Up
Safe == /\ x \in 0..(N - 1)
        /\ y \in 0..(N - 1)
====