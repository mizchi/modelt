---- MODULE Roots ----
EXTENDS Naturals
VARIABLE x
Init == x \in {0,1}
Next == UNCHANGED x
P == <>(x=1)
====