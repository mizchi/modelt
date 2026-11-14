---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 0 /\ x' = 3
A2 == x = 2 /\ x' = 1
A3 == x = 0 /\ x' = 3
A4 == x = 2 /\ x' = 1
A5 == x = 0 /\ x' = 3
A6 == x = 2 /\ x' = 1
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4 \/ A5 \/ A6
Spec == Init /\ [][Next]_x /\ WF_x(Next)
Prop == (x = 0) ~> (x = 0)
====