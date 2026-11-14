---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = {}
Next == \E n \in 1..3: x' = x \cup {n}
Safe == Cardinality(x) < 2

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = {})
__TraceNext == ((__position = 0 /\ __position' = 1 /\ (x' = {1})) \/ (__position = 1 /\ __position' = 2 /\ (x' = {1,2})) \/ (__position = 2 /\ __position' = 2 /\ (x' = {1,2}))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == <>(~(Safe))
====