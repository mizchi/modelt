---- MODULE Collections ----
EXTENDS Integers, Sequences, FiniteSets
VARIABLE x
Init == x = <<0>>
Next == x' = [x EXCEPT ![1] = @ + 1, ![1] = @ + 1]
Safe == x[1] < 2

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = <<0>>)
__TraceNext == ((__position = 0 /\ __position' = 1 /\ (x' = <<2>>)) \/ (__position = 1 /\ __position' = 1 /\ (x' = <<2>>))) /\ (Next \/ UNCHANGED <<x>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,__position>> /\ WF_<<x,__position>>(__TraceNext)
__Expected == <>(~(Safe))
====