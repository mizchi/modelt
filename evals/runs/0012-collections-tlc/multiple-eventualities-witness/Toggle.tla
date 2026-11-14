---- MODULE Toggle ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == x' = 1 - x
Spec == Init /\ [][Next]_x /\ WF_x(Next)
Prop == <>[](x = 0) \/ <>[](x = 1)

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 0)
__TraceNext == ((__position = 0 /\ __position' = 1 /\ (x' = 1)) \/ (__position = 1 /\ __position' = 2 /\ (x' = 0)) \/ (__position = 2 /\ __position' = 3 /\ (x' = 0)) \/ (__position = 3 /\ __position' = 4 /\ (x' = 1)) \/ (__position = 4 /\ __position' = 5 /\ (x' = 0)) \/ (__position = 5 /\ __position' = 1 /\ (x' = 1))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__OriginalFairness == WF_x(Next)
__Expected == __OriginalFairness /\ ~(Prop)
====