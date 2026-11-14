---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 2 /\ x' = 0
A2 == x = 1 /\ x' = 2
A3 == x = 0 /\ x' = 0
A4 == x = 1 /\ x' = 0
A5 == x = 0 /\ x' = 0
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4 \/ A5
Spec == Init /\ [][Next]_x
Prop == <>[](x = 0) \/ <>[](x = 0)
====