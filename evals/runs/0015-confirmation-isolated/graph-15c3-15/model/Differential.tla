---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 1 /\ x' = 1
Next == A0 \/ A1
Spec == Init /\ [][Next]_x /\ WF_x(Next)
Prop == ([]<>(x = 0)) /\ ([]<>(x = 2))
====