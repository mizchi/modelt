---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 0 /\ x' = 1
A2 == x = 0 /\ x' = 2
Next == A0 \/ A1 \/ A2
Spec == Init /\ [][Next]_x /\ WF_x(Next) /\ SF_x(A0)
Prop == [](x < 3)
====