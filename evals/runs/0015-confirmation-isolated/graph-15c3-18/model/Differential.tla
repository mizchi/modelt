---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 1 /\ x' = 0
A2 == x = 2 /\ x' = 2
A3 == x = 0 /\ x' = 0
A4 == x = 0 /\ x' = 1
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4
Spec == Init /\ [][Next]_x /\ SF_x(A0)
Prop == []<>(x = 1)
====