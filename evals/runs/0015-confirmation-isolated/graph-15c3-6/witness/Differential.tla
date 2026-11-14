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

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 0)
__TraceNext == ((__position = 0 /\ __position' = 0 /\ (x' = 0))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == ~(Prop)
====