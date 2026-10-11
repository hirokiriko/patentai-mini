# Issue 148: catalog-first linked attempt

This is the implementation contract for the next OWNER-only attempt on PR 149.
It supersedes the ordering in the older preflight documents; it does not issue
an approval, refresh an expired deadline, or establish live acceptance. The
previous attempt and its accounting are retained unchanged. New Cloud, DB and
permission operations remain stopped until the one consolidated Local approval
packet is confirmed. No merge, production deployment, third-party invitation,
or new public-access setting is included.

## Prepare before starting the clock

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
