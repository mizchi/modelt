---- MODULE Toggle ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1 - x
Spec == Init /\ [][Next]_x 
Prop == x = 0 /\ x = 1

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 0)
__TraceNext == ((__position = 0 /\ __position' = 0 /\ (x' = 0))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == <>(~(Prop))
====