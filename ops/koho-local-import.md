# Local public-corpus import — Issue #89

`LOCAL_IMPORT_FIRST_V1` authorizes the bounded workflow in Issue #89. The Azure
benchmark in Issue #75 / PR #76 is deferred, not passed. This entrypoint creates
no Azure infrastructure. The synchronous public import API stays disabled.

## Operator procedure

1. Confirm the Issue's residual/cost, existing TLS target, backup, migration,
   single-writer and exact reviewed-code gates. Preserve cumulative attempts;
   never retry a write with an unknown outcome before read-only reconciliation.
2. Build with the existing dependencies:
   `pnpm exec tsc -p scripts/koho-production-import.tsconfig.json`.
3. Keep original packages unchanged. Copy them to an owner-only, Git-ignored
   input directory with restrictive Windows ACLs. Bind name/size/SHA-256 to the
   previously approved input record. The entrypoint creates a bounded exclusive
   snapshot underneath that protected directory, verifies it, and parses it.
4. Pass an `ImportConfiguration` JSON to
   `node .koho-ops/scripts/koho-production-import.js` through private stdin.
   Obtain legitimate credentials inside the Local owner process only. Never
   put configuration, credentials, hashes, source text or authenticated URLs
   in command arguments, terminal output, public logs, GitHub or `.env` files.
   Connection fields are host/port/database/user/password; `expectedTarget`
   independently binds host/port/database/user. Production mode requires all
   production gates. Fixture mode is restricted to an isolated named Local DB.
5. Run JPA then JPB once each, at most 120 minutes/package. Reserve the attempt
   durably before launch and terminate only its child on deadline. Retain
   aggregate outcomes and code/input bindings privately. Same-package reuse
   validates all stored fields without changing IDs or cursor timestamps.
   Package writes and the document-count check share one transaction.
6. Reconcile counts, parser classifications, cursor, restart/OOM status and
   connection closure. Preserve successful production corpus and migrations.
   Remove only operation-owned temporary roles/grants, snapshots, processes
   and fictional cases; never delete original packages or existing cases.

Production migration uses the existing Drizzle path for missing 0001/0002 only.
Do not regenerate migrations, use db:push, change shared ACL/RLS or widen
network access. App/import privileges stay limited to the Issue's exact scope.

## Local verification

The real PostgreSQL suite takes `KOHO_LOCAL_DB_TEST_CONFIG` from the owner
process. It refuses non-loopback targets and unrelated database names. CI
explicitly skips it without that private configuration; CI success is not
real-DB evidence. It covers admission, least privileges, immutable reuse,
corrupt-state refusal, SQL-error and suppressed-insert rollback, and the shared
import/watch lock. Run it with:
`pnpm exec vitest run scripts/koho-production-import.test.ts`.

On 2026-09-13 the same JPA/JPB inputs saved 1,048/580 documents, totaling 1,628,
on isolated PostgreSQL 16. Both retain parser status `review_required`, with
1,045/580 documents so classified. JPA took 262,810ms with peak RSS
1,961,168KiB; JPB took 36,819ms with peak RSS 1,156,800KiB. DB growth was
4,079,616/1,867,776 bytes and measured WAL delta 3,999,336/1,914,360 bytes.
These are Local functional/capacity results, not Azure or production acceptance.
Exact bindings and raw local evidence are protected; no source identifiers or
original content belong here. Later targeted fixes require their own evidence.

## AI and user procedure

The four analysis/extraction/query operations establish a request budget.
Watch shares six normal sends across screening/detail; extraction and queries
each share four fast sends across SDK/outer retries. Issue-wide Local durable
reservations remain normal12/fast8 across requests/cases/processes. Unknown
sends remain consumed. This is not a new global customer billing system.

The Azure guard rejects external context/non-text inputs and output above8,192
before transport. Its serialized UTF-8 byte count plus8,192 framing reserve is
a conservative engineering estimate, not an official guarantee of the model's
final token count. Confirm live model/input-count compatibility before claiming
the strict token gate complete. Explicit35-second abort signals reach the SDK;
budget/timeout stops fail watch without fallback or cursor advancement.
The effective serialized body ceilings are141,808 bytes for normal and41,808
bytes for fast requests, including system/schema. Long Japanese inputs or many
candidates can reach them before the model's token limit. Report that refusal;
do not silently discard input or candidates to obtain a passing acceptance run.

After production acceptance, use public/fictional data only: create a case,
input the draft, review extracted claims/search queries, search the corpus and
attach candidates. Save the watch start date, run manually, review findings,
save review status, reload, export CSV or open print view. Run again without
new imports to verify no duplicates or unnecessary AI call. These are the
eventual operating steps, not a claim that production/browser tests passed.
Customer-data acceptance, login, scheduling, notifications and automatic
acquisition remain outside this Issue.

The conditional revised reserve is JPY5,326: past five attempts1,574 + shared
uncovered1,500 + production execution/storage/cleanup1,000 + AI1,252. The
cancelled unexecuted Azure allocation is3,417 from the prior8,743 plan. This is
not a final invoice or a resource cleanup guarantee. Historical managed-resource
tracking remains unknown. Local TCP/TLS connectivity to the approved production
DB was unavailable on the bounded read-only check; no network change was made.
