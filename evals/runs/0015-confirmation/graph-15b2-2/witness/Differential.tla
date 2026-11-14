---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0}
A0 == x = 0 /\ x' = 1
A1 == x = 1 /\ x' = 2
A2 == x = 2 /\ x' = 1
A3 == x = 0 /\ x' = 0
A4 == x = 0 /\ x' = 1
A5 == x = 0 /\ x' = 1
Next == A0 \/ A1 \/ A2 \/ A3 \/ A4 \/ A5
Spec == Init /\ [][Next]_x
Prop == []<>(x = 0)

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 0)
__TraceNext == ((__position = 0 /\ __position' = 1 /\ (x' = 1)) \/ (__position = 1 /\ __position' = 2 /\ (x' = 2)) \/ (__position = 2 /\ __position' = 3 /\ (x' = 1)) \/ (__position = 3 /\ __position' = 2 /\ (x' = 2))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == ~(Prop)
====