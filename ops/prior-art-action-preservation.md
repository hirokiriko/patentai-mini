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

