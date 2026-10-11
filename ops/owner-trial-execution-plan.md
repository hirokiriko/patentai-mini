# Issue 148: one acceptance plan, 2026-10-10

This supersedes the successor requirement and the optional artifact grant in
`owner-trial-preflight.md` for this acceptance run. It is an execution contract,
not permission or evidence that deployment passed. All real IDs, IP, assignment
IDs, input hashes, UTC instants and credential references belong only in the
existing OWNER-private manifest. No push, CI, image update, Azure/Graph operation,
credential creation or live AI call was performed during this refinement.

**Current decision: do not start. Additional approval alone is insufficient.**
Offline integration is implemented. Exact-head CI, fixed external evidence and the specific additional approvals below remain necessary before live execution.
One branch, one writer, Draft/no-auto-merge, OWNER only, no invitation, no main
merge and no production configuration or data change remain mandatory.

## Selected lifecycle

Use one dedicated Manual guardian Job (0.25 CPU / 0.5 GiB, retry 0, parallel 1),
one read/lease/CAS rehearsal of at most 300 seconds and one main execution of
at most 1,800 seconds. No successor resource, successor assignment, receiver
execution or extension is part of this plan; incremental successor cost is zero.

Let T0 be the main Job's **actual platform start**, obtained by OWNER readback.
READY must be persisted by the bound MI/image/execution/replica and consumed
within 15 seconds, before T0+300 seconds. A late READY never moves a deadline.
Local DB use ends at T0+600 seconds, including startup and READY waiting. Begin
cleanup earlier on completion, OWNER heartbeat loss or any uncertainty. The
guardian continues checking during the remaining 20 minutes. At T0+1,500 seconds,
an unclosed operation produces a durable warning and OWNER recovery obligation;
the guardian continues. Job timeout at T0+1,800 seconds is never a success signal.
The original six-hour limit is an approval ceiling, not the work duration.

OWNER stays responsible for the already-approved fault exception. If the cloud
Job fails or an operation remains unknown, stop DB use and retain the journal,
unknown reservation and recovery obligation. Do not start a replacement Job,
extend grants, repeat PUT, or claim rule removal without terminal evidence. A
normal run may not contain an unmonitored interval. OWNER must have the fixed
recovery procedure and deadline recorded before the first PUT.

Closure requires terminal evidence for every sent PUT/DELETE, exact rule GET404,
a complete server firewall list showing absence, and unchanged preexisting rules
and network settings. A GET404 alone cannot prove that an unknown PUT will not
apply later, or settle an unknown DELETE. The implementation never substitutes
404 for operation-terminal evidence or guesses a lost operation URL.

## LRO choice and approval delta

Select one dedicated custom observer role at the fixed subscription scope,
with exactly these Actions, no DataActions, no wildcard and no Reader role:

```
Microsoft.DBforPostgreSQL/locations/azureAsyncOperation/read
Microsoft.DBforPostgreSQL/locations/operationResults/read
```

Change only the planned LRO role's AssignableScopes and its one guardian
assignment from the fixed RG to that subscription. Counts stay seven custom
definitions and eighteen ARM assignments. This is an **additional scope approval**.
IAM would permit these PostgreSQL LRO reads across the subscription and can
expose operation metadata; the region, returned URL and request binding are
application restrictions, not equivalent IAM restrictions. No subscription-wide
resource read, operation list, Activity Log or guessed operation-ID scan follows.
Saved material does not prove that RG scope fails; it also does not establish
an enforceable region-only role-assignment scope. This selects one valid parent
scope instead of relying on either unresolved assumption.

The adapter requires the local approval record, exact scope/action set,
principal, assignment/readback evidence digest and finite end before polling,
then rechecks after credential acquisition with persisted time high-water and
monotonic elapsed time. A returned LRO URL is not itself permission. Effective
polling remains unmeasured. Rehearsal has no PUT and therefore cannot manufacture
a real write-operation URL to prove DELETE/LRO behavior. Record the first real
LRO result as an acceptance observation; a 403 or unknown result retains the
cleanup obligation and must not cause broader access or a retry.

## Complete IAM inventory

Scopes are exact IDs from the existing private manifest. All role Actions,
DataActions, assignment IDs, principals, conditions and inherited access must
be read back. Runtime grants last through the formal trial end; retained login
serves only the closed-period page afterward. Revoke unnecessary runtime grants
at that end with approved OWNER administration; do not add a post-end writer.
Non-Blob ARM RBAC has no invented automatic time condition: record explicit
removal deadlines and verify absence. Guardian recovery IAM stays only for the
approved cleanup window, at most eight hours, and is removed after closure.

| Group | Principal → exact scope | Number | Selected role / condition | Approval classification |
|---|---|---:|---|---|
| Runtime | Web MI → originals, artifacts, budget containers | 3 | Trial Storage RW | Existing trial scope; exact access check pending |
| Runtime | worker MI → originals container | 1 | built-in Storage Blob Data Reader | Existing trial scope |
| Runtime | worker MI → budget container | 1 | Trial Storage RW | Existing trial scope |
| Runtime | Web and worker MIs → fixed AI account | 2 | Responses-create only | Existing trial scope |
| Runtime | Web and worker MIs → fixed ACR | 2 | fixed-repository reader if registry ABAC, else AcrPull | Existing scope; inspect registry mode, never change it |
| Runtime | Web MI → exact trial worker Job | 1 | Job read/start/executions read | Existing trial scope |
| Guardian | guardian MI → exact firewall child | 1 | firewallRules read/delete, no PUT | Existing guardian scope; absent-child assignment effectiveness pending |
| Guardian | guardian MI → fixed DB server | 1 | flexibleServers read + firewallRules read/list | Existing guardian scope |
| Guardian | guardian MI → fixed subscription | 1 | only the two LRO Actions above | **Additional scope approval** |
| Guardian | guardian MI → dedicated journal container | 1 | journal Blob read/write/lease | Existing guardian scope |
| Guardian | guardian MI → dedicated image in fixed ACR | 1 | mode-appropriate pull permission | Existing guardian scope |
| Guardian | OWNER → journal container | 1 | journal RW, exact state.json/rehearsal.json; List denied; fixed UTC ≤8h | Existing guardian scope |
| Local input | OWNER → originals container | 1 | Trial Storage RW, exact 1 package hash + 4 numeric-case sample keys; List denied; UTC ≤1h | **Additional data-access approval** |
| Local input | OWNER → budget container | 1 | Trial Storage RW, only trial-v1/state.json; List denied; same UTC ≤1h | **Additional data-access approval** |
| Local artifact | OWNER → artifacts | **0** | No assignment is created | Omitted from normal acceptance |

Runtime 10 + guardian 6 + additional OWNER 2 = **18 ARM assignments**.
Dedicated Entra OWNER assignment is **one separate directory assignment**,
outside that ARM count. There is no nineteenth conditional artifact assignment.
Authenticated Web MI routes perform PDF/CSV and full-save reconciliation.
If Local artifact recovery becomes necessary, stop and describe the concrete
existing delivery/three-key change; it is not an implicit part of this run.

The **seven custom definitions** are: exact-rule remover; server observer;
two-action LRO observer; journal RW; Trial Storage RW; Job control; AI create.
Journal RW has no management Actions and only Blob read/write DataActions.
Trial Storage RW adds container metadata read, which is required by the Local
private-container check; OWNER input grants reuse this definition, not journal RW. The Blob UTC condition does not time-limit the metadata Action. Remove each temporary OWNER assignment by its recorded deadline and verify absence, or first prove unchanged existing OWNER access already covers it.
Job control has only Microsoft.App/jobs/read, jobs/start/action and
jobs/executions/read. AI create has only the DataAction
Microsoft.CognitiveServices/accounts/OpenAI/responses/write. Blob Lease is
covered by Blob write; there is no Blob delete, account-key, delegation-key or
account-management grant. The built-in Blob Reader remains container scoped.

Freeze exact numeric case IDs and immutable filename/hash pairs before creating
the OWNER grants. `operatorBlobCondition` emits exact path equality, strict UTC
start/end and Blob.List denial. No wildcard UUID-case directory is permitted.
Verify parser acceptance and positive/negative effective access; never retry
with broader or unconditional RBAC. The old private proposal with wildcard
paths is superseded and remains NOT_APPROVED/NOT_EXECUTED historical evidence.

## One authentication/credential model

Create a dedicated, single-tenant Entra app/SP, exact trial redirect/origin and
audience, assignment-required plus the fixed OWNER OID allowlist. Choose **one
finite client secret**, created no earlier than the approved setup and expiring
at **2027-01-29T00:00:00Z**. No renewal is implicit. Store it only as the dedicated
trial App platform secret referenced by Easy Auth; never in worker configuration,
Next.js environment, source, command arguments, logs or production secrets.
Do not inspect/reuse production auth credentials to justify the isolated model.

Approval must explicitly cover this secret's type, sole purpose, target and
lifetime and the existing operator's target-specific app/SP credential and OWNER
assignment operations. No new Graph application permission, tenant consent,
directory role, service-wide credential or Key Vault is requested. At the
retention review, remove that credential and confirm its absence, then handle
app/SP deletion only under the existing retention decision. Earlier revocation
uses the same exact credential key ID; never enumerate/delete unrelated secrets.

Database credentials are distinct: NOLOGIN owner, Local-only migrator, Web and
worker login. Migrator validity ends with the fixed DB-use cutoff T0+600 seconds;
Web/worker end at 2026-10-31T00:00:00Z. Only the matching DB URL enters each trial
secretRef. The existing administrative credential stays in the protected Local
normal chain; it is not created, rotated or copied into App/Job. The Local signing
key stays OWNER-private through necessary approved policy updates; public keys
only are packaged. No secrets or signing keys were generated by this refinement.
If the original authority cannot substantiate any of these concrete credential
operations, record that specific difference before performing it.

## Acceptance quantities and sequence

Use four **wholly fictional** existing JPA fixtures, packaged in one ZIP. The
managed-package receipt currently accepts JPA only; no JPB feature is added. Do not label them public patents. Preserve the input XML/ZIP hash and
four numeric case IDs in the private record. No external document retrieval is
needed. Run two comparison passes (8 runs, normal at most 24 calls) and 6 mini
extractions per pass (12 calls). Maximum normal input/output: 150,000/8,192
tokens; mini: 50,000/8,192. Failed/unknown calls consume reservations, unknown
resends zero. Runtime Job at most 12 starts/6 total hours, App active at most
48 hours. The remaining four Job slots are reservations for necessary denial,
failure and cold-start checks, not a requirement to spend them.

1. Freeze the validated offline implementation at one head. Later, with
   authorization to resume external operations, check exact-head CI and independent
   review, then build locally (at most two builds). Push two dedicated images only after step2 and all additional authority gates pass.
   Pin actual digests and check OWNER push and each MI pull; no paid cloud build.
2. Reconcile exact cost ledger rows and public transfer prices. Preserve all
   unsettled amounts. Verify fixed resources, actual IPv4 and the original network
   approval. Any changed IP/target/risk stops before a network write.
3. Materialize the approved plan with exact UTC times, sample hashes, principal
   and assignment IDs, role bytes/ABAC, creation/cleanup receipts and budget
   reservations. Use the selected auth model and eighteen-assignment inventory.
4. Rehearsal verifies MI identity, image, fixed resource read, private journal
   Lease/ETag/CAS and permissions. It does not claim live DELETE or AI success.
5. Start the one main Job. Bind actual T0/replica/execution, initialize its fixed
   state, maintain OWNER heartbeat, wait for fresh guardian READY, then send the
   single approved rule PUT. Local connect/query/COMMIT requires the guardian's
   current ≤10-second lease and the separate one-hour ticket.
6. Catalog-only preflight checks fixed server version/tier, DB/roles/ACL and
   isolation. Create only the trial DB/four roles; migrate via the same guarded
   Client and set T-only least privileges. Do not use generic drizzle-kit CLI,
   production data or existing-DB ACL changes. Verify role denial against other
   DB/schema/DDL/role changes and DELETE. If existing PUBLIC CONNECT prevents
   isolation, stop instead of modifying existing databases.
7. Complete fixed package/sample/settings input before T0+600 seconds. No more
   than one bootstrap plus 16 sequential operator requests in one Node process. Bootstrap uses at most four connections; the process caps all connection attempts at 20, including failures. Each permit reader caps itself at 2,000
   GETs including refresh. Permit renews during Blob waits, checks every SQL and
   COMMIT, closes on loss and uses a 1-second server statement timeout with ≥2s
   send margin. Socket closure is not proof of server rollback/COMMIT failure.
8. Request rule removal immediately. Keep terminal/LRO receipts and exact
   absence+list+baseline evidence. The cloud App/worker's continuing DB path must
   be verified independently; removing the Local IP rule does not prove it.
9. Through actual OWNER login, verify unauthenticated/wrong-owner rejection,
   sample comparison, mini flow, cost/AI counts, findings/review/save and cold
   start. For each of 8 runs, initial and updated saved versions: PDF and CSV
   each fetched twice (up to 64 GETs); inspect every page/row and reopen each
   saved version (32 displays). Compare hashes, row counts and final-page content.
   No blank or truncated output counts as a pass.
10. Exercise signed initial-phase expiry rejection and later formal-trial end
    refusal without moving an ended window forward. Existing active requests
    must not admit new AI/DB writes at expiry. Unknown settlement stays reserved;
    no post-end Local artifact grant or migrator extension is included.
11. Reconcile actual charges/ledger reservations. Remove only this run's guardian
    assignments/Job/unused custom definitions/image/journal after terminal closure,
    observing creation receipts and remaining references. Retain trial objects
    for the approved period/review. Record OWNER guide, limitations and explicit
    remaining unverified checks. Publish only sanitized counts/results.

## Conservative cost and exact missing reads

Saved exchange rate is 173.305 JPY/USD. Use no free-tier credit without a matched
meter/path. Use the current approved private forecast rather than an older
document subtotal. Integer rates are normal434/2,600 and mini130/780 per million
tokens, Job38/hour. The forecast includes contingency1,000 yen:
guardian 500 + other 500, **not two additional amounts**. Start threshold is
4,500 yen, absolute initial cap 5,000; unused headroom is not a new reserve.
Existing project reservations and unsettled amounts remain retained.
October project allocation model remains 38,331 + 5,000 + 10,000 = 53,331 yen. Issue148 initial plus trial/retention remains cumulative15,000 yen; trial/retention10,000 is not a monthly regrant.

| Guardian input | Conservative quantity |
|---|---:|
| Compute | rehearsal 300s + main 1,800s + 600s billing allowance; allowance does not extend execution |
| Blob operations, priced all as writes | 100,000 (48,347 guardian + 5,250 OWNER heartbeat + 40,000 DB permit + 3,000 OWNER control + 3,403 shared OWNER/Web/worker data, including Blob ledger traffic) |
| ARM requests | 7,000 (6,309 guardian + at most600 wrapper + at most91 shared OWNER/Web/worker; the former59 unallocated requests are included, not added) |
| Journal payload | write ≤64KiB; response-body read ≤64KiB + one overflow-detection byte |
| Logs / log retention | 0.1GB / 0.3GB-month |
| ACR incremental / journal retained | 1GB-month / 0.01GB-month |
| Successor | zero resource, execution and cost |

At saved rates guardian known subtotal is **173.20968225 yen**, leaving
326.79031775 inside its existing 500. Body+image transfer model is
72.04943848 GiB for both images (compressed ≤1GiB each, runtime pulls ≤16,
guardian pulls ≤2, pushes ≤2), Blob and ARM. Proposed overall transfer envelope
is 100GiB = guardian 32 + other 68. Header/App/AI response/PDF/CSV/extra-pull
mapping is not yet demonstrated; **100GiB is not an enforced/verified cap**.
The 3,403 data calls share a durable32GiB request-plus-response reservation across OWNER/Web/worker; remaining96,597 Blob calls use64KiB in each direction. Accepted Blob bodies total43.79162598GiB, ARM13.671875GiB and images20GiB. Remaining22.53649902GiB must cover mapped stream overrun, headers/TLS, App, AI responses, reports and logs. This replaces the earlier OWNER-only38.37756348GiB subtotal; do not keep that smaller subtotal after enabling runtime reads. These application limits are not a wire billing cap. Image layers must be measured before their update. Normal/mini AI request
bodies total at most 3,905,088 bytes for this input; responses are separate.

Define E_guard and E_other as sums over distinct billed paths of bytes/1e9 times
the applicable yen/decimal-GB rate. Accept only if
`173.20968225 + E_guard + uncovered_guard_cost <= 500`,
`other_nontransfer_cost + E_other <= 500`, and the fully mapped initial forecast
is <=4,500 and cap <=5,000. If all guardian32GiB is billed, its available transfer
rate is <=9.510850 yen/GB; for other68GiB with 100 yen nontransfer allocation it
is <=5.478368 yen/GB. Those are threshold equations, not current Azure prices.
Do not replenish a reservation merely because an estimate was below its limit.

Missing public price operation, not executed: GET
`https://prices.azure.com/api/retail/prices` with filter
`serviceName eq 'Bandwidth'` and `currencyCode='USD'`, then only same-official-host
pagination. Save direction, region, tier, unit and effective date as
`official-bandwidth-prices-<UTC>.local.json`; send no resource IDs or credentials.

Missing ledger evidence, not a vague overlap caveat: stable ETag GET plus second
GET of the fixed global `managed-services/patentai-standard-managed-watch/state.json`,
and existing trial `trial-v1/state.json`; only the specifically referenced
`evidence/<digest>.json` for unresolved administration differences. Create a
private mapping of category/phase/local reservation/global operationId,
requestDigest,intentDigest,evidenceDigests/trial id,intent,execution/allocation.
The key systems differ; timestamps alone cannot establish identity. Saved
aggregate output discarded raw bodies and cannot reconstruct these rows. Use
already-authorized current read access only; no old expired grant recreation.
If that read is not currently authorized, the exact read-only scope/time delta
must be reviewed separately. Never release the 11,527 unsettled amount by inference.

Formal trial fixed input: normal12/mini12, Job12/3h, App24h, logs0.1GB. Saved
normal/max-token forecasts 590.347/1,711.724 yen must map to actual operations
and remain below the 1,800 stop forecast/2,000 monthly cap; no 14/31 proration.
Retention conservative four complete month-equivalents is 273.893634 yen from
68.4734085 per month (closed App2h, storage3GB, backup1GB, logs0.005GB, other20yen).
Include actual retained auth/App/image/storage/logs and cleanup residual charges.

## Decision matrix and remaining work

| Classification | Concrete result |
|---|---|
| Existing authority; executable now | Local code/tests/review and private plan records. After hold is lifted, authorized fixed-target read checks only; no external operations during this refinement. |
| Additional approval, then conditional execution | Two exact OWNER data grants; one LRO scope change to fixed subscription; one finite dedicated Easy Auth client secret of the model above. Counts and lifetimes do not broaden automatically. |
| Offline implementation complete | Persistent OWNER session and python -m trial_guard.execution start/prepare/work/close/prove/handoff workflow; fixed Job adapter, fsynced request counters, one-start/no-resend receipts, 25-minute warning and30-minute retained obligation. Node binds actual signed DB window, runs guarded bootstrap/input sequentially, stops on permit expiry/parent EOF/clock rollback. Recovery is cleanup-only including terminal Job readback. |
| Dedicated DB bootstrap implemented | Fixed four roles/DB, catalog hazard checks, nine approved existing migrations through guarded Client, per-DDL/COMMIT unknown receipts, fictional cases, exact trial ACL/runtime denial checks. Reconciliation reads original receipts/catalogs. Unknown passwords require fixed-credential login, not mere role existence. No admin membership/shared DB ACL expansion. |
| Effective environment validation pending | Existing admin capability; isolation without existing-DB changes; 10-minute bootstrap/input feasibility; exact absent-child RBAC; ABAC parser/effectiveness; ACR mode/pulls; LRO behavior; dedicated Easy Auth login; App DB route after Local rule removal. |
| Cost evidence pending | Finite request counts are enforced offline. Image layers, transfer path/quantity mapping and rate, stable ledger correspondence and current budget require fixed external reads. |

Offline checks do not prove live ACL effectiveness, normal gap-free cleanup or
10-minute DB completion. Actual timing and each acceptance result must be
recorded. The private final record ties all check counts and independent reviews
to the exact local head. Remote CI is unrun until authorized push/readback.

## Offline launch artifacts and held external reads

A fresh start also requires current (at most10-minute-old) exact-head CI/review, matching IPv4/server/rule, all unsettled retained, initial forecast <=4,500 and cap5,000, and private evidence digests for network approval, IP, isolation, ledger, prices, effective permissions and additional authority. Offline results cannot set these live gates. Expired initial evidence never prevents cleanup-only resumption.

The protected JSON launcher input contains fixed guardian Job/template/identity
digests, approval records, OWNER grant interval, prearm/seed bounds, original
signed policy/ticket, existing signing key and DB credentials, fictional source
paths, absolute Node/compiled-script/recovery paths. No secret is generated.
Actual T0 must fit the existing signed policy and one-hour ticket. The bridge
preserves prices, budgets, policy/grant periods and DB targets. It first saves an
exclusive/fsynced trial-runtime-policy.pending.json intent, then runs bootstrap.
Before the first ledger operation it binds the measured DB baseline (at most
64MiB), derives the matching operator digest/signature with the existing key,
and saves the final public environment to private trial-runtime-policy.json.
Never deploy the pending artifact. A failed/unknown final save stops before all
operator requests and keeps the completed/unknown bootstrap receipts.
App, worker and ledger must use that exact policy for subsequent validation.
The ten-minute DB permit is separate from the one-hour data grant.

trial-session.jsonl uses an OS writer lock and fsynced hash chain. Restart keeps
all counters and performs cleanup-only recovery; it never repeats Job start,
rule PUT, bootstrap or inputs. owner-storage-budget.jsonl cannot reset after
process loss. Bootstrap target/step receipts are independent of passwords and
tickets; unknown COMMIT/DDL never succeeds by inference. Each SQL is awaited;
parallel or poisoned-client SQL is refused. PGOPTIONS/PGREPLICATION/PGSERVICE
injection is rejected, and actual TLS/identity/timeout settings are read back.

After the hold is lifted, minimum read-only evidence is:

1. The public Bandwidth price GET/pages and the two previously approved fixed
   public IPv4 checks. Compare the one current IPv4 with the approval.
2. Fixed DB metadata, complete firewall list and exact child GET; isolated DB
   catalog/admin capability evidence without editing existing DB ACLs.
3. Fixed ACR/AI/Storage/environment metadata and normal/mini exact deployment
   GETs, without a deployment collection scan. Check registry mode, not change it.
4. Exact planned18 assignment and7 definition GETs plus necessary scope
   permissions. Guardian Job start/read/replica response schemas including
   terminal recovery need read-verification before enabling launch.
5. Exact trial App/Job/execution/auth settings and named manifest HEAD/GET.
   No listSecrets, listKeys or tenant-wide discovery.
6. Two stable ledger state GET/re-GETs and only referenced evidence files;
   explicit operation/digest/reservation correspondence preserves unsettled sums.
7. After separate directory/secret authority and exact object creation, their
   app/SP/OWNER assignment and credential metadata GETs.

No old budget grant-window script may be rerun for these reads: it includes
permission changes. Missing read permission remains a specific scope/time delta,
never an implicit renewal or broader role.

Saved global price evidence expires2026-10-28T15:00Z. Trial cost profiles are
valid at most24h in code. Refresh only approved exact prices and re-evaluate
before expiry, or refuse new paid work at expiry. Do not extend stale evidence
to formal trial end or invent a fresh monthly allocation.

Directory binding formats are explicit: Python recovery_directory_digest uses SHA256 of the canonical JSON string path; the signed TS recoveryDirectoryDigest uses SHA256 of the raw resolved path. Do not interchange the two.

OWNER guardian commands must run under the existing approved Azure CLI Python.
Token acquisition invokes that same `sys.executable -I -m azure.cli account
get-access-token` once, with no shell, PATH wrapper, installation or fallback.
The normal OWNER profile/broker is inherited; stdout/stderr stay captured and
the existing absolute deadline applies. A missing CLI module stops this path.
Only ARM token claims accept the canonical `management.azure.com` and
`management.core.windows.net` resource identifiers (with zero or one final
slash). Storage keeps only `https://storage.azure.com` with that same slash
handling. Tenant, principal and expiry checks remain mandatory. Microsoft
documents the ARM resource identifier separately from its request endpoint in
the [REST reference](https://learn.microsoft.com/en-us/rest/api/azure/) and
[CLI endpoint list](https://learn.microsoft.com/en-us/cli/azure/azure-cli-endpoints).
Recovery's exact execution GET must return the requested execution ID before
replica inspection; a different execution with the same template is insufficient.

## Shared lifetime communication counter

The trial-only bootstrap creates `public.trial_network_budget` inside T-DB,
with two fixed quota rows and append-only request identities. Web and worker
reuse their existing database credentials. Their grants are SELECT, INSERT and
UPDATE only on requests, reserved_bytes, observed_bytes and http_status; neither
gets table DELETE, DDL, or permission to edit binding/slot/request metadata.
The migrator uses the existing guarded connection. No Azure role or credential
is added. Standard migrations and production schemas are unchanged.

Every final Blob SDK send, including ledger HEAD/GET/PUT, failed sends, range
downloads and SDK recovery, first reserves one request and its full accepted
body ceiling in one SQL statement. ARM Job requests use the same mechanism.
The shared lifetime allocations are3,403 Blob requests/32GiB and91 ARM
requests/182MiB; the latter reuses the existing7,000-request/2MiB-per-request
ARM model, including its former59 unallocated requests.
The allocation is shared across roles, policies, phases, retries and restarts;
it is never renewed by a process-local counter or a new ticket. OWNER's existing
fsynced file counter remains an additional restriction, not a second allocation.
A separate transaction-status query must prove the reservation committed before
HTTP begins. SQL timeout, lost acknowledgement, an outer uncommitted transaction,
missing table or exhausted allowance means no HTTP send. Observation records
status/accepted bytes but never refunds a request or byte reservation, including
unknown outcomes. No lease or Blob write is needed to meter a Blob ledger read.

The table allocation is8MiB within the existing192MiB DB growth allowance, not
additional capacity. Each HTTP attempt uses at most three accounting SQL calls:
reserve, committed proof, observation. OWNER calls pass the existing10-minute
database/guardian guards and consume their existing permit-read allowance;
there is no new deadline or allowance. Initializing the Blob ledger now requires
the guarded T-DB connection. Worker reuses its one client; Web uses its existing
two-connection pool. Bootstrap verifies the exact table owner, columns, defaults,
PK/CHECK constraints and absence of user triggers/inheritance before accepting
an uncertain DDL readback. No reconciliation recreates or resets quota rows.

The source-enforced ceilings are accepted application bodies, not billed wire
bytes. Headers, TLS, stream overshoot, App/AI responses, image pulls and transfer
path pricing still need the current private cost gate. The historical forecast
above is not a substitute for that gate. Live PG16 behavior, ten-minute timing
and effective permissions must pass on the exact candidate head before launch.
