---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 2 /\ x' = 1
A2 == x = 0 /\ x' = 3
A3 == x = 2 /\ x' = 1
A4 == x = 0 /\ x' = 3
A5 == x = 2 /\ x' = 1
A6 == x = 0 /\ x' = 3
A7 == x = 2 /\ x' = 1
A8 == x = 0 /\ x' = 3
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4 \/ A5 \/ A6 \/ A7 \/ A8
Spec == Init /\ [][Next]_x /\ SF_x(A0)
Prop == [](x < 4)
====