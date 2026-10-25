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
