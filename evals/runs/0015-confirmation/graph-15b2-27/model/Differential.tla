---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 0 /\ x' = 1
A2 == x = 0 /\ x' = 1
A3 == x = 0 /\ x' = 1
A4 == x = 0 /\ x' = 1
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4
Spec == Init /\ [][Next]_x /\ WF_x(Next) /\ SF_x(A0)
Prop == <>[](x = 0)
====