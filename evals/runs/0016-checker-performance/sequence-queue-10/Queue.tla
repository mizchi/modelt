---- MODULE Queue ----
EXTENDS Naturals, Sequences
VARIABLE queue
Init == queue = <<>>
Next == IF Len(queue) < 10 THEN \E message \in {0,1}: queue' = Append(queue,message) ELSE queue' = Tail(queue)
Safe == queue \in Seq(0..1) /\ Len(queue) <= 10
====