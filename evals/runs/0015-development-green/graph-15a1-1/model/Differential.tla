---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 2 /\ x' = 0
Next == A0 \/ A1
Spec == Init /\ [][Next]_x
Prop == <>(x = 0)
====