---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 0 /\ x' = 2
A2 == x = 0 /\ x' = 0
A3 == x = 1 /\ x' = 1
A4 == x = 1 /\ x' = 2
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4
Spec == Init /\ [][Next]_x
Prop == <>(x = 1)
====