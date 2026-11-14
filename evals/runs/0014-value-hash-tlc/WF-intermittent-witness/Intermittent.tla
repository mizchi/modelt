---- MODULE Intermittent ----
EXTENDS Naturals
VARIABLE x, done
Init == /\ x = 0 /\ done = FALSE
Tick == /\ x' = 1 - x /\ UNCHANGED done
Finish == /\ x = 0 /\ done' = TRUE /\ UNCHANGED x
Next == Tick \/ Finish
Spec == Init /\ [][Next]_<<x, done>> /\ WF_<<x, done>>(Tick) /\ WF_<<x, done>>(Finish)
Prop == <>done

VARIABLE __position
__TraceInit == Init /\ __position = 0 /\ (x = 0 /\ done = FALSE)
__TraceNext == ((__position = 0 /\ __position' = 1 /\ (x' = 1 /\ done' = FALSE)) \/ (__position = 1 /\ __position' = 2 /\ (x' = 0 /\ done' = FALSE)) \/ (__position = 2 /\ __position' = 3 /\ (x' = 1 /\ done' = FALSE)) \/ (__position = 3 /\ __position' = 4 /\ (x' = 0 /\ done' = FALSE)) \/ (__position = 4 /\ __position' = 1 /\ (x' = 1 /\ done' = FALSE))) /\ (Next \/ UNCHANGED <<x,done>>)
__TraceSpec == __TraceInit /\ [][__TraceNext]_<<x,done,__position>> /\ WF_<<x,done,__position>>(__TraceNext)
__OriginalFairness == WF_<<x, done>>(Tick) /\ WF_<<x, done>>(Finish)
__Expected == __OriginalFairness /\ ~(Prop)
====