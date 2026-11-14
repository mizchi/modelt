---- MODULE Differential ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = ([ [a |-> 0] EXCEPT !.b = Head(<<>>) ])
Next == UNCHANGED x
Prop == x # x

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = [__key \in {"a"} |-> IF __key = "a" THEN 0 ELSE TRUE])
__TraceNext == ((__position = 0 /\ __position' = 0 /\ (x' = [__key \in {"a"} |-> IF __key = "a" THEN 0 ELSE TRUE]))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == <>(~(Prop))
====