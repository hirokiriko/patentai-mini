# Local public-corpus import — Issue #89

`LOCAL_IMPORT_FIRST_V1` authorizes the bounded workflow in Issue #89. The Azure
benchmark in Issue #75 / PR #76 is deferred, not passed. This entrypoint creates
no Azure infrastructure. The synchronous public import API stays disabled.

The OWNER approved `PRODUCTION_FINISH_V2` on 2026-09-14. Prefer the existing
management route; if it cannot run the reviewed import within available
resources, one current-source IPv4 rule on the already-public target DB is
permitted. Verify its exact target, existing rules, create/delete permissions,
DNS/TCP/TLS and SQL identity. Keep a private pre-change/intent record and an
expiry no later than six hours; remove only this rule and read back its absence
and unchanged other settings. Unknown writes need reconciliation, not retries.
Historical fifth-attempt managed tracking UNKNOWN remains a separate accepted
residual subject to danger signals and reserves; new cleanup cannot use that
exception. No new Azure environment or public-access enablement is authorized.

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
Do not regenerate migrations, use db:push, change shared ACL/RLS or exceed the
Issue's temporary network exception. App/import privileges stay narrowly scoped.

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
Azure uses zero SDK retries and one outer attempt: watch needs at most two
normal sends for screening/detail; extraction and queries each need one fast
send. The guards retain their maximum ceilings. Issue-wide Local durable
reservations remain normal12/fast8 across requests/cases/processes. Unknown
sends remain consumed. This is not a new global customer billing system.

The Azure guard rejects external context/non-text inputs and output above8,192
before transport. Its serialized UTF-8 byte count plus8,192 framing reserve is
a conservative engineering estimate, not an official guarantee of the model's
final token count. Missing/noninteger usage, actual input above the estimate or
role threshold, or output above its requested cap stops subsequent sends.
Only reconciled numeric usage receipts can release a private cost reservation;
unknown/failed sends retain it. Explicit35-second abort signals reach the SDK;
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

### V2 cost reservation

The JPY5326 figure above is historical, not a fixed quote. Retain past1574,
shared1500 and production/recovery1000 reserves. Refresh the remaining AI
forecast and reserve the worst model-context cost before each possible send.
Before an HTTP action that may make two sequential sends, reserve both; never
reset counters on a new request, case or process. Inspect fixed numeric
`ai_operation_usage` receipts privately after each action. Missing receipts,
unknown sends or excess usage stop the next action without releasing reserve.

The verified model specifications are gpt-5.4 (2026-03-05), context1050000 /
input922000, and gpt-5.4-mini (2026-03-17), context400000 / input272000.
Conservatively charging the entire context as input plus8192 output gives
USD5.43432 / USD0.336864 per send, using high normal rates5/22.5 and mini
rates0.75/4.5 per million input/output tokens. Round up and apply the recorded
conservative currency/tax factors; cached discounts are not assumed. Reconcile
only measured usage below the original estimate and preserve future work's
forecast within the JPY9000 gate. This is a bounded operator acceptance process,
not a guarantee for future customer spending or a mathematical input-token cap.

Sources: [Microsoft model limits](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure?pivots=azure-openai#gpt-54),
[normal pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-gpt-5-4-in-microsoft-foundry/4499785),
[mini pricing](https://techcommunity.microsoft.com/blog/azure-ai-foundry-blog/introducing-openai%E2%80%99s-gpt-5-4-mini-and-gpt-5-4-nano-for-low-latency-ai/4500569).
