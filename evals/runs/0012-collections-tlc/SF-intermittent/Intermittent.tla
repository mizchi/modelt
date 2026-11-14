---- MODULE Intermittent ----
EXTENDS Naturals
VARIABLE x, done
Init == /\ x = 0 /\ done = FALSE
Tick == /\ x' = 1 - x /\ UNCHANGED done
Finish == /\ x = 0 /\ done' = TRUE /\ UNCHANGED x
Next == Tick \/ Finish
Spec == Init /\ [][Next]_<<x, done>> /\ WF_<<x, done>>(Tick) /\ SF_<<x, done>>(Finish)
Prop == <>done
====