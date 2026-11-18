# Issue 150: preserve fact citations and conditional premises

The retained comparison failed correctly on an uncertainty sentence containing
an embedded conditional assertion. Independent replay also exposed two defects:
the target request omitted action-level locations for otherwise identical fact
descriptors, and a source reading separated the first half of a coordinated
property premise into an unconditional stop.

The source decoder now retains the action occurrence it already resolved. It
binds the locator to the validated source digest, original claim and fact
digest, in the existing claim / loop / fact order. The target receives a compact
dictionary of these action and term/operator/frame positions. These are
fallible original citations, not a source meaning or an acceptance verdict.
The target still reads the whole original and unchanged generated text.
Source-ID, original-claim, subject, context and semantic checks remain in force.
The raw answers, persisted witness, fact IDs and saved-result format do not
change. The combined descriptor/locator budget remains 12,000 bytes.

New generations must express unknowns as the existing nominal reservation
grammar. The description illustrates the required form; an early local check
rejects an embedded assertion before sending review. This is not a
provider-enforced regex or automatic repair. A rejected generation is retained
verbatim in the existing private v2 audit with step generation_check and a null
review, so no review send is invented. Public errors contain no raw text.

For the bounded printed syntax “stop A, close B when … comparative speed
property”, the source check now requires both original premise spans and their
connecting proof. It rejects an independent stop/close fact extracted from
those premises. Original-position cues help the model read that syntax.
Independent commands, later maintenance and quoted examples remain separate.
This deliberately limited grammar is not general Japanese semantic coverage.

Local retained-answer replay kept the original bytes. The locator-only replay
preserved all 79 facts and the persisted witness, with 6,290 descriptor bytes
and a 50,814-byte target request. The stricter source check rejects the retained
missing-premise answer, and the existing target rejection remains a rejection.
No corrected provider response was substituted to obtain acceptance.
Fictional decoder/SDK regressions cover complete premises, omitted parts,
wrong occurrences, loop/key ordering, same-predicate actions, unchanged audit
capture and no review dispatch after early rejection.

Real AI, same-result exports and final OWNER-ON handoff are still unverified
for this change. The deployed service stays OFF pending fresh bounded approval.
Do not close #150 on code, CI or deployment success alone. #94 retains human
practitioner evaluation pending; #152 research is outside this change.

## Proposed one-time financial supplement

Preparation is not financial activation or live execution authority. A fresh
signed supplement may add exactly one unit from the active literal-condition
predecessor: forward23/cap114000 to forward24/cap119000; stop23 is inert.
The fixed addition is base4732 (AI2000, image1115, other1217, storage400) and
remaining pool535, total5267. Preserve every previous earmark, unresolved bill
and the separate OWNER2000. No rebind/stop/reactivation replenishes the unit,
changes the approved November boundary or releases an old hold.

Proposed product plan118613 plus unchanged outer reserve16937 is outer135550.
Proposed Issue plan126180.5555; these values are not an approval. After monthly
apply intent, keep the new image OFF on failure. A known monthly result before
activation permits the stopped ledger; UNKNOWN is never confirmed stopped.
Do not roll back the ledger or old image after activation.
