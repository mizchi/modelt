---- MODULE Differential ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
A0 == x = 0 /\ x' = 1
A1 == x = 2 /\ x' = 0
Next == A0 \/ A1
Spec == Init /\ [][Next]_x
Prop == <>[](x = 2)
__HasNext == ENABLED Next

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 1)
__TraceNext == ((__position = 0 /\ __position' = 0 /\ (x' = 1))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == <>(~(__HasNext))
====