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
Automatic retry policy remains unchanged. A finite real run must independently fit its measured request costs,
send counts and all original deadlines before dispatch. Quality improvement is
unproven until actual full-source QA passes.


Three parts reduce each request's owned fact groups and obligations; they do not
reduce the common original context.
This is an unconfirmed latency hypothesis. Waiting for HTTP headers does not
prove which provider-side stage was slow. No retry is admitted merely because
a local timeout ended. Historical two-part audit records remain readable, but
changed task IDs or request bodies cannot reuse their old answers. A changed
roster requires fresh finite funding, deadline admission and actual source QA.

## Source transport deadline

Identified Azure high-effort source requests now have one 420-second absolute
deadline covering headers and the full response body. Each admitted request owns
an Undici dispatcher with the same header/body allowance; it is destroyed after
the full response is read or the request fails. The shared dispatcher is unchanged.
Generic/watch requests remain at 35 seconds, and generation, review, unknown
models and lower-effort source requests retain their existing limits.

The operation deadline is fixed once from the admitted source request count,
up to 25, plus the unchanged later-stage and diagnostic-QA allowances. Neither a
new phase nor an aborted request resets it or permits a retry. Before a finite
real run, its complete remaining work must still fit the original owner expiry,
retained reservations and send allowance. A local timeout does not establish
provider termination or release its reservation.
