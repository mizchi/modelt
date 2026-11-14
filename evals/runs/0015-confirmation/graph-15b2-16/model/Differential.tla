---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 1 /\ x' = 0
Next == A0 \/ A1
Spec == Init /\ [][Next]_x /\ SF_x(A0)
Prop == [](x < 2)
====