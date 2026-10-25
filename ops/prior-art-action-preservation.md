# Preserve actions in extracted meanings

The source decoder uses `a` to validate an exact action occurrence, then removes
that validation field. For the generic `executes` relation, `J` must therefore
retain the complete action as well as its operands. Two operation names alone
cannot distinguish switching between them from merely executing them.

The claim validator now requires a `J` quotation to contain the complete `a`
span at the same original occurrence. The prompt states that requirement
explicitly. Missing actions are rejected; the decoder never fills or repairs
them. Existing quotation, actor, condition, route, and full-source checks remain.

Fictional regression cases cover both an earlier controller and a postposed
apparatus subject, reject operands-only answers without modifying them, and
retain the accepted complete switching meaning through the existing decoder.
# Quotation ranges and mode-scoped actors

Each quotation range covers all clauses containing its literal text, independently
of the fact's anchor group. Cross-clause actions retain their punctuation and
cannot be accepted under only the last clause's number. The extraction prompt
and provider schema now state this distinction at the quotation field.

An explicit controller continues as the actor of its active operations across
mode boundaries. The mode is a separate condition; only a route's path subject
uses its mode label. Fictional two-mode regression coverage preserves both
controller citations and cross-clause actions through the strict decoder, and
rejects incorrectly narrowed citation ranges without modifying raw answers.

## Bounded extraction partitions

Claims with at least 30 original clauses and 20 explicit action obligations
use three fixed, contiguous extraction responsibilities. All requests retain the
unchanged complete source, references, clause IDs and source digest. Group and
possession/set ownership follows original clause R; complete recognized loops
belong to the part containing their unchanged route-start coordinate. Each part
cites its own full actors and conditions,
including references across the boundary. Original obligation IDs are retained.

Local scope projection and literal span interning are structural operations;
they do not create or repair meaning. All parts are required exactly once, and
the combined result still passes the existing full-source schema and decoder.
An incomplete part cannot produce a comparison, saved result or accepted QA.
The original 19-claim limit remains; at most 25 source requests are admitted.
Request timeouts, operation time ceilings and automatic retry policy remain
unchanged. A finite real run must independently fit its measured request costs,
send counts and all original deadlines before dispatch. Quality improvement is
unproven until actual full-source QA passes.


Three parts reduce each request's owned fact groups and obligations; they do not
reduce the common original context or raise the 270-second request deadline.
This is an unconfirmed latency hypothesis. Waiting for HTTP headers does not
prove which provider-side stage was slow. No retry is admitted merely because
a local timeout ended. Historical two-part audit records remain readable, but
changed task IDs or request bodies cannot reuse their old answers. A changed
roster requires fresh finite funding, deadline admission and actual source QA.
