---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 1 /\ x' = 0
A2 == x = 3 /\ x' = 2
A3 == x = 1 /\ x' = 0
A4 == x = 3 /\ x' = 2
A5 == x = 1 /\ x' = 0
A6 == x = 3 /\ x' = 2
A7 == x = 1 /\ x' = 0
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4 \/ A5 \/ A6 \/ A7
Spec == Init /\ [][Next]_x
Prop == <>(x = 3)
====