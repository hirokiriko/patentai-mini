# Complete fact input for comparison generation

Generation previously received original claims and quote options, but not the
decoded typed facts already available at that point. It now also receives
`closedFacts`: complete rendered fact candidates, their unchanged IDs/claim-local
positions, and the guaranteed parent claims with their original text and facts.
This is input guidance, not a replacement proof. Ambiguous reference alternatives,
missing claims/facts or unrenderable facts are explicitly `closed:false`.

Review additionally receives typed support-selection guidance. A relation has one
supporting fact under the existing comparator contract; path/set evidence keeps
its existing multi-fact rules. This does not remove unrelated IDs from an answer,
add missing conditions to an answer, or relax source/claim/position validation.
Original source facts, original claims and quote choices remain available.
Parent and child facts stay separate complete statements in the same field, with
separate original claims and supporting IDs. Their guards are never unioned into
one atom. A target which actually prints all source guard clauses retains the
original separate clause granularity and exact text spans. Missing clauses are
still rejected. Local synthetic decoder probes demonstrate this existing valid
path; they do not repair the original case98 response.

Both actual prompts still pass the existing request-byte gates. Reservation must
cover the actual added payload before any paid execution. Local fictional tests
show transport of these inputs and preservation of successful guarded decoding;
they do not establish model compliance. The retained case98 response remains a
quality failure when replayed unchanged. No paid retry or acceptance is implied.
This input improvement does not guarantee detection of every generated field
which omits all parent statements. Actual acceptance still requires original-text
review of every field, including inherited conditions; a failed field cannot be
handed off merely because typed decoding succeeded.
