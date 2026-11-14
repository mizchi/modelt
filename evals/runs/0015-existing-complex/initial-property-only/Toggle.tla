---- MODULE Toggle ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1 - x
Spec == Init /\ [][Next]_x 
Prop == x = 0
====