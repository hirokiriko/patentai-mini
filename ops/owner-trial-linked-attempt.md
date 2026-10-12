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
plan alone determines cumulative admission. A fourth transition is rejected.

The dedicated child is `trial-provision-successor-v4`. New code requires exact
HEAD checks and image builds, while unchanged evidence is reused. The corrected
fictional input contract is described in [owner trial](owner-trial.md).
Image cost is recalculated from all retained images and the new build; a higher
forecast within the start gate does not itself approve a larger cost allowance.
Monetary caps and unsettled reservations remain separate approval constraints.
The amendment sets no start time or response deadline and does not establish
live acceptance. Readiness and an ample new execution window precede activation.
