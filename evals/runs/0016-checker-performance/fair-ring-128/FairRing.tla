---- MODULE FairRing ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = IF x < 127 THEN x + 1 ELSE 0
Spec == Init /\ [][Next]_x /\ WF_x(Next)
P == []<>(x = 127)
====