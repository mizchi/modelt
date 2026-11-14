---- MODULE Terminal ----
VARIABLE x
Init == x = FALSE
Next == x /\ UNCHANGED x
P == <>x
====