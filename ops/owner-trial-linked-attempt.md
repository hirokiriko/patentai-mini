# Issue 148: catalog-first linked attempt

This is the implementation contract for the next OWNER-only attempt on PR 149.
It supersedes the ordering in the older preflight documents; it does not issue
an approval, refresh an expired deadline, or establish live acceptance. The
previous attempt and its accounting are retained unchanged. New Cloud, DB and
permission operations remain stopped until the one consolidated Local approval
packet is confirmed. No merge, production deployment, third-party invitation,
or new public-access setting is included.

## Prepare before starting the clock

Keep the approved manifest bytes unchanged. The reviewed display-region alias
`Japan East` maps to ARM location `japaneast` only in derived requests, expected
readbacks, authentication/origin bindings and PostgreSQL LRO scope. Other display
spellings remain rejected; normal canonical location IDs keep their existing
validation. Include the original approved region spelling in the offline
bridge/compiler/resolver checks before publication.

Real UTC clock observations may include fractional seconds. Compare the exact
observation with approval and fixed-window boundaries; do not round admission
checks. Preserve the exact bridge `checked_at`. The compiler rounds only its
serialized preparation and credential-start timestamps up to the next whole
second. Approved window/source timestamps remain whole seconds, and a replay
reuses the saved observation and allocations without renewing any window.

Finish local tests, isolated PostgreSQL 16 regression, independent review,
exact-commit CI and automatic Preview first. Build both images locally from
that commit with an empty Docker credential configuration and save image-ID
readback receipts. Derive each new registry tag from the original tag plus
`-<first twelve commit characters>`; do not overwrite the retained runtime tag.
The approval packet binds these receipts, source hashes, the old journal's
terminal chain hash, limits, current IPv4 comparison, cost and absolute time P.
Local build/preparation neither opens a journal nor starts an execution window.

Only a reviewed Local launcher may supply the separately pinned approval SHA;
request JSON cannot choose a trusted SHA. Once approved, activation is issued
once with the approved absolute P, at least five minutes after issuance. A
missed or revoked deadline is not rolled forward. The old journal is a read-only
parent of `trial-provision-next.jsonl`; the existing physical control budget,
original seed and accumulated requests are reused, never reset or refunded.

| Window relative to P | Permitted work |
|---|---|
| 0–30 minutes | Fixed new guardian/runtime image publication |
| 35–80 minutes | Foundation, read/lease rehearsal, main configuration |
| 80–140 minutes | OWNER input and bounded runtime/auth setup |
| 95–125 minutes | Initial acceptance policy |
| 125–140 minutes | Earlier OWNER access cleanup margin |
| 35–515 minutes | Guardian recovery permissions, maximum eight hours |

One guardian main Job remains limited to 1,800 seconds from its actual platform
start. DB use is at most 600 seconds from that same start, including readiness
wait. No successor, restart or substitute Job is authorized. Cleanup and
terminal absence evidence take priority over starting further work.

## Remove the catalog/bootstrap cycle

The schema-2 preparation starts with `pending_catalog`. It supplies only the
catalog connection and signed, bounded plan to a persistent Node worker.
Bootstrap secrets are delivered in a second private pipe frame only after the
parent fsyncs the first catalog receipt. All permit reads and OWNER token misses
are brokered by the parent; a missing/revoked broker cannot fall back to CLI.

The catalog plan enumerates at most six connectable databases, including
`postgres` and connectable `template1`. An exclusion must name a database that
is explicitly non-connectable; unknown databases or changed inventory stop the
attempt. Use the committed PostgreSQL 16 builtin allowlist, not a baseline
learned from the target server. Each pass uses the same open connections,
repeatable-read read-only transactions and nineteen fixed queries per database.
Per-query and aggregate row/byte caps reject oversized metadata. Three passes
check cluster membership, database/schema/object/default/column ACLs, dangerous
routine/type/extension access and existing-object invariance.

Pass 1 is durable before secret delivery. Pass 2 immediately precedes the first
DDL and issues a non-serializable, single-use capability. Bootstrap consumes it,
runs the fixed ten operator commands, then pass 3 permits only the exact new
trial DB/roles/memberships. Runtime artifacts are released only after the third
receipt and later imported with the closed DB-window proof. A forged boolean or
unbound JSON receipt cannot stand in for this sequence.

PostgreSQL 16 administrators without superuser require CREATEROLE/CREATEDB and
an explicitly approved temporary SET membership in the new trial owner role.
Validate automatic ADMIN back-grants, grant only the one required SET option,
create the new DB, and immediately revoke that exact grantor membership. This
optional permission delta must be in the pinned authority. An unknown DDL ACK
does not permit reconnecting, repeating DDL or guessing a cleanup result.

Use at most twenty DB connection attempts: D catalog connections, four
bootstrap connections, and ten operator connections. One two-second shared
heartbeat covers all open DB sessions; loss, rollback, invalid permit, expiry
or pipe EOF revokes every session. No automatic reconnect or write retry exists.

## Preserve accounting and publication recovery

The starting control totals are 187 / 32 / 0, with existing ceilings
600 / 3,000 / 5,250. An append-only phase plan reserves OWNER ARM requests:
fresh reads 24, publication 24, provision 180, run 42, cleanup 120 and
unallocated 23. Forward work stops at 457; cleanup remains bounded by 577.
Provision separately caps HTTP at 170 and token misses at 10. Count and fsync
before every send; retain charges for failed or unknown outcomes. A shared
memory-only token pool binds OWNER/tenant/audience and revokes on time faults.

The existing lifetime journal also contains one historical debit marker pair:
intent at row 1, three ordinary OWNER ARM request rows, and completion at row 5
(zero-based after the binding row). Replay validates the exact historical source
hashes, same-directory references, matching intent/completion and 128-to-131
counts. The two markers are metadata and add no charge; their three request
rows are counted once normally. Thus the 62-row prefix remains seed 128/32/0
plus 59 requests, totaling 187/32/0. No record, seed or existing charge is
rewritten. Unknown, partial, duplicate, reordered or inconsistent markers are
rejected before the new phase plan or any send. Historical source files are
not reread as current evidence merely to replay this already recorded debit.

Before and after publishing the new runtime image, authenticate reads proving
the old tag and digest are unchanged. New-tag preexistence or an unknown upload
stops forward work. A positively acknowledged guardian publication can still
be cleaned up when runtime publication is unknown: require exact ownership,
three fixed resource-absence reads, terminal DELETE and authenticated digest
absence. Never delete the retained runtime image or infer an unknown PUT's
outcome from an unrelated 404.

New compressed image measurements and current rates must fit the approval's
unchanged total ceilings and existing unsettled reservations. A proposed
reallocation of the initial non-AI allowance is an approval delta, not an
automatic change to the live ledger. Do not treat missing billing as zero.

## Local Docker readiness and a stopped attempt

An image build receipt does not establish that the same local Docker engine is
still running at publication time. Before a first publication, inspect the
fixed image using the pinned Docker executable, named pipe, tag and image ID,
an exclusive OWNER-only empty credential configuration and a maximum twenty
second timeout. Keep the existing authenticated inspect as a second check.
There is no fallback context/pipe, automatic engine start, pull, retag or push
retry. A missing engine, timeout, malformed output or wrong image stops before
OWNER authentication, registry HTTP and request debits. Preparation must also
check both local images before fresh metadata collection.

Empty probe configurations have their own durable path and file identities.
Cleanup removes only the known files and directory, without recursive deletion
or adoption of an unrecorded path. Local cleanup remains available after the
publication window. Previous slot/probe history prevents another first attempt
before authentication. Positively acknowledged uploads can still use the
existing GET-only readback recovery without a running Docker engine.

The stopped pre-push attempt retains its seven-row child journal and all 71
control-budget rows: the original seed, the 62-row historical prefix, the first
phase plan and eight charged requests. Its totals are 195/32/0. Neither Docker
startup nor successful local inspection authorizes continuing that attempt.

A separately approved V2 succession may append exactly one transition to the
same physical budget and use `trial-provision-successor` as its new child. Its
sealed proof binds the original V1 authority, activation, publication, child and
counter bytes. Only the exact stopped-before-push history is eligible; any
write intent, unknown outcome, changed bytes, duplicate transition or partial
record fails closed. Original completed-parent evidence remains at 187/32/0;
it is not relabeled as the new starting state.

The successor inherits only unspent allocations: OWNER ARM fresh reads 18,
publication 22, provision 180, run 42, cleanup 120 and unallocated 23; a separately
hash-bound `succession.phase_reallocation` may explicitly transfer exactly six
unspent OWNER ARM requests from provision to fresh reads, producing 24/22/174/42/120
with unallocated 23. The fixed normal provision inventory uses 135 HTTP requests
and at most ten OWNER token misses, leaving 29 of those 174 requests for additional
HTTP observations (not 29 poll invocations); exceeding this allowance stops forward
work while cleanup remains reserved.
With or without this fixed transfer, the spent 195 and remaining allocations sum
to the unchanged 600 ceiling. The non-cleanup
ceiling remains 457. Existing cost estimates, reserves and unsettled amounts
are retained. A new reviewed HEAD, exact local builds, tests, independent
review, CI and a consolidated approval with explicit fixed windows are required
before issuing any successor activation or writing the real transition. Local
tests use copies/fictional journals and never append to the 71-row original.

## Verification and remaining live acceptance

CI runs lint, type checks, both Python suites, the managed build, Vitest and
Next build. Isolated PG16 tests exercise the real database transport and
bootstrap/catalog/operator order with fictional local fixtures. Mocked HTTP
tests exercise real request accounting, token sharing, unknown publication and
terminal cleanup. These checks do not establish Azure permissions or live
OWNER sign-in, real AI, browser, PDF/CSV or expiry acceptance.

After the consolidated approval and fresh checks pass, follow the fixed Local
launcher phases without reissuing clocks, broadening IAM, or switching paths.
Unconfirmed writes retain their reservations and recovery obligations. Save
public-safe CI/review evidence in this Draft PR and account-specific receipts
only in the OWNER-private Local record.
### Closed publication continuation

`ISSUE148_LINKED_ATTEMPT_V3` is a separate, independently approved continuation
of V2 only after both publications are acknowledged, the exact guardian DELETE
has a 202 acknowledgement and authenticated 404, and all four Docker/probe
configurations are absent. The verifier replays V1 and V2, rejects provisioning
or unknown writes, and validates the cleanup observation at its historical
DELETE time. It cannot refresh evidence, renew an old execution window, reset a
counter, or authorize a third successor.

The original lifetime budget and every charged request remain intact. The V3
authority must explicitly bind its balanced phase transfer and release of the
23 unallocated control requests; a previous six-request transfer is not approval
for this change. The global 600-request cap, 120-request cleanup reservation and
all monetary reservations remain. Non-cleanup requests stop at 480. Preparation
alone never issues this authority. The new child journal is fixed to
`trial-provision-successor-v3`, with a single transition appended while both the
counter and previous-child locks are held.

Live source validation reads exact Git blobs with one bounded `cat-file --batch`
process, validates every blob hash and compares every current file. Loaded-module
paths remain checked on each call. No archive export transformations or cached
approval booleans can replace the committed-byte proof. This keeps source checks
inside the existing evidence freshness limits without extending those limits.

### Input-contract correction after a closed V3

The explicitly approved V4 continuation retains all 148 counter rows and the
270/32/0 usage. It verifies the closed V3 publications, local preparation bridge,
and acknowledged guardian removal through the normal operation builders. No
foundation, DB, IAM or runtime write may be present in that predecessor. The
original 71-row prefix and both earlier transitions remain independently bound.

Only the separately hash-bound human amendment permits the third transition to
raise the effective OWNER request cap from 600 to 631. The original journal
header and V1–V3 limits remain 600. The new allocation is fresh reads 24,
publication 22, provision 153, run 42 and cleanup 120, with no unallocated
requests. Its 31-request addition exactly matches the closed V3 consumption;
no previous debit is refunded. Non-cleanup admission stops at 511. Existing
callers still pass the nominal 600 request-class argument; the verified active
plan alone determines cumulative admission. V4 alone cannot authorize a fourth
transition.

The dedicated child is `trial-provision-successor-v4`. New code requires exact
HEAD checks and image builds, while unchanged evidence is reused. The corrected
fictional input contract is described in [owner trial](owner-trial.md).
Image cost is recalculated from all retained images and the new build; a higher
forecast within the start gate does not itself approve a larger cost allowance.
Monetary caps and unsettled reservations remain separate approval constraints.
The amendment sets no start time or response deadline and does not establish
live acceptance. Readiness and an ample new execution window precede activation.

### An unacknowledged V4 publication

A Docker push can fail after its intent has been persisted but before its
positive exit status and manifest digest are recorded. A local image inspection
does not test the Docker daemon's registry connection. Preserve that outcome as
UNKNOWN; a later repository listing, including an OWNER's Portal observation,
does not establish the original process acknowledgement, absence of uploaded
blobs, successful cleanup, or zero cost. Never repeat that old intent.

The narrowly scoped V5 succession supports only the stopped V4 publication
history: all 158 budget rows, 279/32/0 usage, the original 71- and 148-row
prefixes, and the 16-row predecessor child with one unacknowledged guardian
intent. The old UNKNOWN remains an unresolved historical operation. Its
reservations are not released, and no delete authority is inferred from it.
The original authorities and all three prior transitions remain verifiable.

An independently approved fourth transition may move six **unspent** provision
requests to fresh reads. The proposed allocation is fresh 24, publication 19,
provision 147, run 42 and cleanup 120: 352 remaining requests plus 279 already
used equals the existing 631 ceiling. Publication's usual inventory is 15 HTTP
requests and at most two OWNER token requests; provision's is 135 HTTP requests
and at most ten token requests. Each leaves only two extra requests. These are
request margins, not promises that an asynchronous operation will complete in
time. Keep the 120-request cleanup reserve and stop before exceeding any cap.

This succession requires a separately approved new HEAD, new image tags and
exact build evidence, a new child journal and fixed execution windows. It does
not reopen V4 or grant a general UNKNOWN retry. Immediately before a newly
authorized guardian publication, the existing authenticated exact-repository
check must still return NAME_UNKNOWN. Existence, an unconfirmed response, stale
evidence or a changed predecessor stops before the new push. A new push still
requires its own positive Docker exit and digest, followed by authenticated
manifest readback. Existing runtime retention and scoped cleanup rules apply.

Local implementation, fictional tests and independent review grant no live
authority. Keep old schedules paused and choose new dates only after readiness
and the OWNER's consolidated approval. Reuse unchanged application tests and
evidence; rebuild only for actual source changes. Actual OWNER login, real AI,
PDF/CSV retrieval, saved redisplay, expiry rejection and cleanup remain separate
unfinished acceptance steps until observed in the trial environment.

### Managed Identity acknowledgement compatibility

Managed Identity can return an ARM resource ID with different letter casing,
including the documented `/resourcegroups/` form. For this provider and the
`userAssignedIdentities` kind only, acknowledgement and readback compare ASCII
resource ID strings case-insensitively. The sealed request URL, request digest
and receipt object ID stay unchanged. Other providers keep exact comparison;
different subscriptions, groups, names, encoded paths and non-ASCII IDs remain
unacceptable. A successful write acknowledgement and matching properties on
readback are both still required.

For future PUT 201 responses only, `Location` is supplementary metadata and
never supplies creation authority, a request target or a polling target. The
MSI contract returns an Identity synchronously; RFC 9110 permits relative
URI references. A bounded ASCII header is classified without resolving,
parsing or following it, including when it names a different host or resembles
an operation URL. Empty, oversized or malformed protocol text is rejected.
The sealed request, complete response body and independent fixed-URL GET
remain the evidence. `Azure-AsyncOperation` and `Operation-Location` are
rejected by presence, including empty values. Duplicate control headers are
also rejected. 200 updates and 202 responses do not prove creation.
The duplicate check runs before header normalization in the Local Identity
transport, which is included in the executor's required source hashes. Other
provider transports and all guardian image files remain unchanged, preserving
the existing images' execution closure for a separately authorized attempt.

Both the initial response and the fixed-URL readback must match every requested
and expected property, contain all three Identity UUIDs (principal, tenant and
client) regardless of receipt projection, and contain no error or nonterminal
status. A digest of all three normalized UUIDs binds the initial acknowledgement
to readback and subsequent cleanup inspection, even when projection is empty.
A changed UUID cannot become verified ownership; missing historical binding is
not inferred. The initial acknowledgement alone remains pending until readback agrees.
This is a deliberately narrow compatibility rule, not a claim about which
header was returned in an earlier stopped attempt. See
[MSI 2023-01-31](https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/msi/resource-manager/Microsoft.ManagedIdentity/ManagedIdentity/stable/2023-01-31/ManagedIdentity.json)
and [RFC 9110 Location semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.2).

Identity rejections record a fixed reason: `resource_id_mismatch`,
`unsupported_lro_headers` or `identity_response_mismatch`. The acknowledgement
also records only the Location classification, reference shape, the fact that
it was not used for authority or polling, and async/duplicate header presence,
alongside the existing digest. It does not persist the response body,
header URI or exception text. See the official
[Identity create example](https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/specification/msi/resource-manager/Microsoft.ManagedIdentity/ManagedIdentity/stable/2023-01-31/examples/IdentityCreate.json)
and [ARM naming rules](https://learn.microsoft.com/en-us/azure/azure-resource-manager/management/resource-name-rules).

An already persisted HTTP 201 UNKNOWN remains UNKNOWN. Reopening its journal
does not issue a token or GET, promote it, or permit another PUT. Portal evidence
of existence and zero visible role assignments is an observation, not the
missing historical acknowledgement or cleanup authority. This compatibility
fix neither resumes a stopped attempt nor changes cleanup admission. Preserve
its journal, cumulative usage and monetary reservations; an unresolved attempt
must not be treated as absent or as a verified creation eligible for deletion.

### Reusing acknowledged images after the first Identity stopped

The V6 continuation is limited to a stopped V5 with two positively acknowledged
image publications and exactly one subsequent Identity PUT with an HTTP 201
UNKNOWN receipt. It preserves all 182 lifetime rows, usage 302/32/0, the original
71-row prefix, all earlier transitions, the old child and every monetary reserve.
An OWNER's later Portal deletion and refreshed absence report is recorded
separately. It does not supply the missing PUT ACK, an authenticated DELETE or
404, measured Portal traffic, or permission to retry the old attempt. A newly
authorized creation must still pass its own authenticated absence check.

Only a separately approved V6 authority can start the new child. Its proposed
remaining OWNER allocation is fresh reads 24, image verification 8, provision
145, run 32 and cleanup 120. This moves ten unspent run requests: six to fresh
reads and four to image verification. The 302 spent plus 329 remaining still
equals 631; non-cleanup work stops at 511. No debit or reserve is refunded.

The new local HEAD and CI identify the corrected operator code. The old image
build HEAD, tags, build receipts, managed-build SHA and publication ACKs remain
unchanged. A hash-bound compatibility review must prove that the application
and guardian execution sources can be reused. Policy and catalog artifact
checks use the sealed image build HEAD; local execution sources and CI must
still match the new HEAD. Unsealed or mismatched inputs fail closed.

Before provisioning, `verify-reused-images` performs pull-only OAuth exchange
and an authenticated digest-addressed manifest GET for each image: six HTTP
requests and at most two OWNER token misses. Both the manifest body/digest and
image config digest must match the historical successful publication. A durable
new readback record links that evidence to V6; it never copies old push ACKs
into the new child or permits a new push. An interrupted verification is not
automatically retried. Provision binding requires both fresh successful reads.

For a sealed V6, C7's `AssignableScopes` is the exact AI resource already fixed
in the approved manifest, matching R6 and R7 even when AI is in another resource
group. The single Responses data action, role definition ID, assignment targets
and counts remain unchanged. Earlier plan formats retain their original bytes
for historical verification. Azure supports a resource instance as an
[AssignableScope](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-definitions#assignablescopes).

Run admission reserves the remaining normal route rather than the previous
fixed floor: normal rehearsal, catalog preparation and main execution require
20 HTTP requests; the 24-HTTP cap allows four additional observations and the
eight-token cap remains separately enforced. Cleanup's 120-request reserve is
unchanged. Request margins do not promise successful asynchronous completion.
Fictional tests measure real consumer calls and assert the lifetime boundary.

This implementation issues no authority or time window. Local readiness,
source compatibility, independent review and the consolidated approval must
precede any live V6 transition. Unchanged evidence can be reused; authentication,
Docker, IP, environment state and image readback need fresh checks. OWNER sign-in,
real AI, PDF/CSV, persisted redisplay, expiry and scoped cleanup remain unfinished
until observed in the trial environment.

An expired V6 with the single unacknowledged Identity write may be inspected
through the separate `unknown_observation` consumer after a new, hash-bound
OWNER read-only grant. It accepts only that historical target, one token read
and one GET within ten minutes, charging both to the unchanged lifetime
counter before sending, under one shared 60-second token/HTTP deadline. A fixed
exclusive marker prevents re-entry even after
a crash or a newly issued grant. The old child and UNKNOWN receipt stay intact.
The transport has no retry or redirect, and source changes, clock rollback,
late results and malformed responses remain unconfirmed. A valid Identity
200 means only current existence; a fixed-target ARM `ResourceNotFound` 404
means only current absence. Neither outcome supplies the old write ACK,
ownership, deletion evidence, released money or a new trial authorization.

A separately approved V7 can retain the observed V6 identity as UNKNOWN and
replace only `names.webIdentity` and `ids.webIdentity` in a new manifest. The
single successful observation, its grant/marker, exact old 34-row child and
199-row lifetime prefix must all agree. Neither deletion nor adoption of the
old target is authorized; its history and every monetary reservation remain.
The new target requires the ordinary authenticated absence check and its own
write/readback evidence before any principal-dependent grant. All other fixed
targets and the seven roles/eighteen assignments remain unchanged.

The lifetime binding, original approval documents and two image build receipts
continue to reference the original manifest. The V7 authority explicitly binds
that origin hash and the new manifest hash. Resource compilation and the new
child use the new hash; image provenance remains attached to the original ACKs.
No build or push is repeated. Source closure compatibility is required for both
retained images, and fresh digest readback is required in the new window.

After the observation, 318 of 631 OWNER requests are spent. V7 allocates the
remaining 313 as fresh reads 24, image verification 6, provisioning 139, run 24
and cleanup 120. The withdrawn 8/8/145/32/120 proposal is invalid: the initial,
rehearsal and main fresh checks alone require 21 HTTP calls. The fixed transfer
from the remaining V6 phases is +6/+4/-2/-8/0, with no refund. Fresh reads allow
21 HTTP and three token misses. Publication allows six HTTP and zero token
misses: it must use the same session's cached ARM token or stop before obtaining
a new credential. Provisioning keeps all 135 normal HTTP calls, with at most
four token misses and 139 combined calls. Run keeps 20 normal HTTP calls, three
token misses and one known poll. Real expiry or additional provider polling can
therefore stop this narrower attempt; no completion or future cache hit is
guaranteed. These smaller allowances require a new explicit approval. Cleanup
retains its independent 120 requests and existing authentication. Failed/unknown requests
are never refunded. The V7 transition is single-use and retains every prefix
byte. V7 uses the same relative windows and fixed formal/retention deadlines
as V6; an expired window is never carried forward automatically. This code and
its fictional tests do not approve a trial or establish live acceptance.

A finite V7 continuation (authority schema 8) handles a local configuration
bridge failure after both image observations succeeded and before any resource
intent. It requires a separately approved corrected HEAD and remaining-work
windows. The V7 child must contain exactly its binding, reuse preparation,
readback intent, six request clock observations and successful readback. The
212-row lifetime prefix must contain exactly V7's first token acquisition,
five metadata GETs and six image verification requests. Additional resource
intent, partial readback, changed history or another continuation is rejected.

The consumed 330 requests remain charged. The remaining phase limits are
18/0/139/24/120, totaling 301; there is no transfer or refund. Fresh-read purpose
limits are also reduced to 16 HTTP calls and two token misses. Initial metadata
retrieval and image verification are prohibited in the continuation. Rehearsal
and main preflights still perform their separate six and ten live reads with
the existing freshness requirements. A new process starts with an empty token
pool; acquisitions are charged to the phase that needs them. Cleanup keeps 120
requests, and normal work remains capped at 511 lifetime requests.

The old VerifiedAttempt validates the original readback at its original time.
The new child records a hash-bound reference to that completed evidence; it
does not manufacture a fresh ACK or change an observed timestamp. The normal
configuration bridge, resource compiler, absence checks and provisioning gates
then operate on the corrected source and the same V7 Web identity target.
Both images, build receipts, original manifest lineage, UNKNOWN resources,
cost reservations, permission limits and formal/retention deadlines stay fixed.
This continuation adds no new trial or formal-start authorization. Its source,
tests and a pending proposal alone cannot open a window or send a request.

### V8 replacement after an UNKNOWN V7r1 identity (authority schema 9)

V8 preserves the exact stopped V7r1 child and the 216-row lifetime prefix with
333 charged requests. It does not adopt, retry or delete the old identity. A
new explicitly approved manifest changes only the Web identity name and ID;
every old UNKNOWN resource and monetary hold remains. The two acknowledged
images and original build HEAD are reused, with both source closures checked.
Historical local-ready evidence alone may use a bounded, hash-bound compressed
encoding; truncated, trailing or oversized streams are rejected before reuse.

The remaining 298 requests are 17 fresh / 0 publication / 141 provisioning /
20 run / 120 cleanup. The transfer from the actual remaining phases is
-1 / 0 / +5 / -4 / 0. Purpose caps are fresh 16 HTTP plus one token acquisition,
provisioning 139 HTTP plus two tokens, and run 18 HTTP plus two tokens. There
is no phase borrowing, refund, image verification repetition or new build.

A schema-9-only profile combines the Web runtime template update and the
memory-only EasyAuth secret delivery into one PATCH. Two stable source reads,
the exact frozen target template, configuration digest and final fixed readback
remain mandatory. Direct appRuntime dispatch is forbidden. An unknown ACK
cannot be resent, adopted or followed as a known operation. Cleanup removes
the secret without restoring or resending a runtime template.

The main preflight uses one fixed Guardian-principal role-assignment List for
G1 through G5. All five exact owned assignments must appear once, with the
approved scopes, roles and principal. Extra/missing rows, duplicates, paging,
conditions and identity changes are rejected. The raw response, request and
historical receipts are bound and revalidated on saved-materialization reload.

Measured fictional real-entrypoint paths require 132 provisioning and 17 run
HTTP calls; the separate actual preflight consumer performs 16 fresh calls.
Seven known provisioning polls and one rehearsal poll consume the remaining
HTTP allowances. With rehearsal at T+35 and 60-minute synthetic token expiry,
four cache misses yield 177 normal requests and preserve 120 cleanup requests
within 631. This does not guarantee real token lifetime, latency or completion.
Shorter expiry, additional polling, unknown writes or a missed window stop the
attempt before borrowing cleanup capacity. The tests exercise production
dispatch/adapters with fictional provider, credential and process boundaries;
they do not establish live Azure, SQL, browser or AI acceptance.

### Stopped partial-foundation diagnostics (no continuation authority)

Host-only Job GETs now retain bounded HTTP/validation metadata on failure.
An empty, HTML, parent-resource or malformed 404 cannot establish absence;
the fixed target must return a strict ResourceNotFound JSON error with no
conflicting target or control header. A denied create records this observation
without writing a mutation intent. Existing unknown receipts stay unknown.
The host transport bounds complete IPC-frame receipt, not only frame arrival.

Reference-list validation rejects error-bearing 200 responses, duplicate JSON
keys, malformed role references, untrusted pagination and incomplete traversal.
Every page is observed before a later failure can discard its diagnostic.
Only three complete zero-reference collections can support role cleanup.
PIM failures and authorization errors are not empty collections, and granting
more permissions or silently dropping an eligibility collection is forbidden.

The stopped-read grant is a distinct, at-most-ten-minute diagnostic capability:
one ARM token and four fixed first-page GETs, charged before invocation to the
existing provisioning plan. It locks the lifetime counter and stopped child,
validates the exact stopped prefix and all thirteen successful ACKs, and creates
an exclusive durable marker before token acquisition. Reissuing the grant or
restarting the process cannot repeat it. Tokens and raw responses remain in
memory; only allowlisted status, stage, length and digest metadata is saved.
These reads cannot issue a new attempt, create a cleanup proof, adopt a resource,
renew a window, release historical UNKNOWN reservations or alter old receipts.

A partial-foundation continuation remains a separate implementation and review
gate. It must import exact old operations/ACKs with provenance, prevent their
recreation, account for cleanup already consumed without refunding it, and
validate all remaining calls against the lifetime cap. A diagnostic result or
this document does not make that continuation executable or establish live
acceptance. Both previously published image closures must remain compatible.
