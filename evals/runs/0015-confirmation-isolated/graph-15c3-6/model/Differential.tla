---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 0 /\ x' = 3
A2 == x = 2 /\ x' = 1
Next == A0 \/ A1 \/ A2
Spec == Init /\ [][Next]_x
Prop == ~([]<>(x = 0))
====