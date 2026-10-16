# Local preparation and one-time access

For the selected acceptance run, use [the single-Job execution plan](owner-trial-execution-plan.md).
It supersedes the successor requirement, RG-only LRO choice, conditional artifact
grant and undecided Easy Auth credential model below. It preserves a no-start
decision until the listed authority, integration and effective-access gates pass.

This supplements `owner-trial.md`. A plan, signed policy, mock test or role count
is not authority to create resources or grant permissions. Keep the original
trial authority, guardian authority and additional OWNER data-access proposal
separate. Never reinterpret the guardian's six assignments as nineteen approved
assignments. No production principal, permission, credential or ACL is changed.

## Fixed inputs and Local execution

1. Prepare complete public packages (at most two), validate provenance, size and
   SHA, then allocate numeric sample case IDs in the trial DB. Fix each sample
   filename once in the existing `13-digit-time-UUIDv4-sample.xml` format.
   A ticket contains case/SHA/key together; UUID case folders are rejected.
2. Create one OWNER-private recovery directory and verify its ACL. Fix the
   maximum one-hour UTC window before any assignment. Prepare `OperatorTicket`
   with `operatorPolicyBinding(policy)`. Put `operatorTicketDigest(ticket)` and
   SHA256 of the resolved recovery directory in `policy.localOperator`, then
   sign the complete policy with the dedicated Local signing key. A different
   ticket or directory requires a new reviewed signed configuration, not retry.
3. `operatorBlobCondition` emits the exact path/time/List-denial conditions for
   originals, budget and (only when necessary) artifacts. Read/write includes
   Blob Lease. Metadata reads remain scoped to the exact container. Validate
   the Azure condition parser and positive/negative effective access before
   inputs; never retry with an unconditional or broader assignment.
4. The launcher must compare each actual ARM readback to the fixed principal,
   assignment ID, container scope, role definition, complete condition bytes and
   the same UTC times/ticket digest. Role definition Actions/DataActions and
   inherited permissions must match the plan. A condition does not revoke a
   broader inherited grant. No new data operation begins with an unverified
   grant/readback, uncertain budget or insufficient time.
5. Each operator invocation reserves five minutes of remaining time. CLI token
   acquisition, final Blob/ARM send and every PG statement/COMMIT are guarded.
   The fixed deadline aborts outstanding work; ROLLBACK/connection closure are
   cleanup. An accepted PUT/COMMIT may still complete: keep its key and unknown
   reservation, never assume rollback from an absent ACK.
6. The Local JSONL receipt is fsynced before dispatch. New-input commands cannot
   run twice. Explicit status/reconcile commands can repeat under a separate
   exclusive lock; they only inspect the same results and apply existing ETag
   settlement. A crash-retained lock requires confirming the original process
   is dead and the original one-hour window has ended before recording and
   removing that exact lock for read/reconciliation only. A new permission
   window is not implicit; require separate existing authority before any new
   send. Never remove the receipt or use this procedure to retry a new input.
   Never change directory or delete
   receipts to bypass unknown results. No raw input/credential is written there.

Normal acceptance needs only OWNER originals and budget assignments. Existing
authenticated Web MI routes handle complete-save reconciliation and PDF/CSV
readback during the active period. If a partial save or initial-validation-end recovery
requires the Local operator, separately bind its existing delivery ID and the
three keys `snapshot.json`, `pdf.pdf`, `csv.csv`; only then use the optional
artifacts read assignment. It shares the original one-hour end, with no renewal.
This only covers recovery inside that original hour. Formal-trial-end Local
recovery is not prepared: neither that grant nor the migrator remains valid.
No artifact write/delete, directory wildcard, MI impersonation, Job exec or new
period-exempt HTTP route is added.

## One IAM and cleanup inventory

All scopes below are fixed IDs in the private manifest, never discovered by a
broad write or inferred from names. The OWNER management chain must already be
able to create/read/delete these exact trial resources and assignments.

| Principal and scope | Count | Permission and authority category |
|---|---:|---|
| Web MI: originals, artifacts, budget | 3 | Trial Storage RW; original trial scope |
| worker MI: originals | 1 | Storage Blob Data Reader, exact container; original trial scope |
| worker MI: budget | 1 | Trial Storage RW; original trial scope |
| Web and worker MI: fixed AI account | 2 | Responses-create custom role; original trial scope |
| Web and worker MI: fixed ACR | 2 | Matching pull role; original trial scope |
| Web MI: exact trial Job | 1 | Job read/start/executions read; original trial scope |
| guardian: exact firewall child | 1 | read/delete only; guardian approval |
| guardian: fixed DB server | 1 | server read + firewallRules read/list; guardian approval |
| guardian: fixed RG | 1 | Planned PostgreSQL async/result read; RG approval exists, effectiveness unresolved |
| guardian: private journal | 1 | Blob read/write/lease; guardian approval |
| guardian: dedicated image in fixed ACR | 1 | matching pull role; guardian approval |
| OWNER: journal fixed paths | 1 | read/write/lease, at most eight hours; guardian approval |
| OWNER: originals and budget | 2 | reuse Trial Storage RW + exact path/time ABAC; proposed additional authority |
| OWNER: three artifact keys if recovery needs them | 0 or 1 | reuse container-scoped Reader + ABAC; proposed conditional authority |

Runtime 10 + guardian 6 + OWNER 2 = 18 planned assignments; the bounded recovery
option makes 19. These are inventory counts, not an expanded authorization.
The guardian's four custom definitions stay separate. Trial adds three:

- Storage RW: Action `Microsoft.Storage/storageAccounts/blobServices/containers/read`;
  DataActions `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/read`
  and `Microsoft.Storage/storageAccounts/blobServices/containers/blobs/write`.
- Job control: `Microsoft.App/jobs/read`, `Microsoft.App/jobs/start/action`,
  `Microsoft.App/jobs/executions/read`; no exec, stop or configuration mutation.
- AI create: DataAction `Microsoft.CognitiveServices/accounts/OpenAI/responses/write`;
  no file, assistant, response-list or response-delete access.

Thus the chosen plan has **seven custom definitions**, reusing the known built-in
Storage Blob Data Reader at container scope (its account-level delegation-key
Action has no effect there). Verify the current definition; do not silently
substitute an eighth custom definition. Reusing OpenAI User would include wider
operations than Responses creation and is not the least-privilege choice.
Microsoft documents the [Responses write DataAction](https://learn.microsoft.com/en-us/azure/role-based-access-control/permissions/ai-machine-learning).

The observed API's LRO URLs are subscription-level provider/location paths,
outside the approved RG assignment scope. The current RG-only plan has **not**
established LRO read authority. Do not widen it to subscription scope. Establish
the effective behavior or obtain a separately reviewed minimal scope change
before opening the firewall; synchronous responses do not eliminate this gate.

ACR permissions mode is not in the saved metadata. Select `AcrPull` only for
legacy registry RBAC, or the repository-reader role and fixed repository condition
for ABAC mode. Do not change registry mode or expand repository access to make
deployment work. Confirm OWNER push and all three image pulls independently.
Blob path conditions support [write and UTC attributes](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-auth-abac-attributes);
parser acceptance and actual enforcement remain live checks.

Create/retention inventory: one trial DB; NOLOGIN owner plus migrator/Web/worker
logins; two UAMIs; one App; one Manual worker Job; three private containers;
one dedicated Entra app/SP with OWNER assignment; trial secret references and
signed profiles; one private application image. Keep these for the approved
trial/retention, not guardian cleanup. The dedicated guardian adds one Job/system
MI, one image, one private journal container and its four role definitions/six
assignments. Track each exact ID, successful creation receipt and dependencies.

## Authentication and credential lifetime

Preserve same-tenant Entra + existing Easy Auth architecture with one dedicated
app registration, audience/redirect URI and OWNER-only assignment/allowlist.
Use one dedicated finite client secret only if the existing Easy Auth client
secret registration is confirmed and the original approval specifically covers
its type, purpose and lifetime. If that concrete authority is absent, leave
credential creation pending and report the exact difference. No new tenant consent, application Graph
permission, directory role, Key Vault, certificate scheme or production secret
reuse is implied. End that auth credential at the retention-review instant so
the authenticated closed-period page remains reachable until review.

DB credentials remain distinct: Local-only migrator expires at the fixed initial
operator-window end; Web and worker expire at the formal trial end. Store only
the matching runtime DB URL in each dedicated secretRef. Keep the signing key
OWNER-local for necessary signed cost/profile updates through the trial end;
the public verification key remains with retained profiles. No actual secret is
generated by this preparation or committed to the repository.

## Guardian adapter and handoff

The standard-library Python package `scripts/trial_guard` contains the real ARM,
MI/CLI and Blob adapters, separate from its fake-clock contract tests. HTTP uses
a killable child with bounded response size, no redirect and no write retries.
Each write has a durable intent before sending. Unknown PUT/DELETE without a
bound operation URL stays unknown; exact404 alone is never terminal proof.
LRO status endpoints and Location/result endpoints have distinct contracts.

The Job image uses the adjacent Dockerfile and `python -m trial_guard`. Provide
only the private bounded configuration through `TRIAL_GUARD_CONFIG_JSON` or Local
stdin. `live_enabled` defaults to denied. The `$CURRENT` execution/replica slots
can only resolve to this Job's platform-injected runtime. After start, OWNER
records actual execution/replica/image/MI readback and creates the exact frozen
journal; startup waits no more than the pre-fixed five-minute READY interval.
Rehearsal is bound to the approved `rehearsal.json` key; main is bound to
`state.json`. Never overwrite/recreate one lifecycle to change its execution ID.
No configuration is printed. The rehearsal performs reads/lease/CAS only and
does not claim to measure firewall DELETE authority.
Before opening, verify effective exact-child DELETE and LRO-read authority for
the actual Job MI. Assignment readback, read-only rehearsal and GET404 alone
cannot replace that verification; actual DELETE/LRO execution remains unmeasured.

Blob state is fenced by a finite 60-second Lease, renewed before ARM writes,
ETag and logical version; fixed target/time/identity fields are compared on every
load/save. Keep at least fifteen minutes of the thirty-minute main execution
for cleanup. A pending/unknown result starts handoff immediately, otherwise no
later than five minutes before Job end. Offer keeps the sender responsible;
claim transfers the fenced writer; acceptance requires a recovery step without
an authorization block. Stale incomplete claims can be reclaimed under the lease
without discarding any in-flight intent. The receiver continues cleanup.
The same entry point in `receiver` mode binds a separate immutable
`successor_runtime`, its actual MI/execution/replica/image, finite availability
and independent ARM readback; it never substitutes the original guardian's
identity. It publishes its own fresh proof, claims a fenced epoch, calls
`Handoff.accept`, and continues recovery. Lease conflicts retain responsibility.
This entry point does not create or restart a successor resource.

Before firewall opening, bind a live, authorized successor independent of OWNER
PC loss through the original six-hour ceiling. No such successor is established
by these tests. Missing successor evidence blocks opening; a pending blob or
platform timeout cannot represent completed cleanup or silently authorize a new
Job. This is a remaining operational requirement, not permission to expand scope.
The successor's exact existing execution authority and journal/delete/LRO
permissions must also be verified; they are not hidden in the six-assignment
guardian count. Before its own availability ends, unresolved cleanup needs an
accepted escalation/continuation. Expired availability only reports attention;
it rejects new readiness/claims, while an already acquired claim keeps performing
cleanup within its distinct fixed permission end. It never produces a successful
exit. Every final send checks the remaining permission time after token/lease
waits, including the persisted clock high-water mark. This unresolved chain
still blocks opening.
An unknown write without an operation URL cannot be solved by this adapter's
`recover` method. A separately authorized, bound terminal-evidence recovery
path is required before live opening; neither a new receiver nor exact404
alone can substitute for that missing proof. No Activity Log grant is implied.

After terminal rule removal, exact404, complete-list absence and unchanged
baseline, delete only manifest-bound guardian assignments, Job/MI, unreferenced
definitions and image, then journal. Require creation receipts and an explicit
zero-reference check. OWNER temporary grants are removed at their own earlier
end. Preserve trial data and its ledger; never recreate the closed old budget
reader grant. All deletion readbacks remain live acceptance work.

## Verification boundary

Run TypeScript tests/type-check/lint/build and Python unittest discovery. These
cover fake time, lost ACK, expiry, denial, competing writers and recovery; they
are not production acceptance. A changed commit invalidates the old image's
source/CI binding: build a new exact-head image, obtain new CI evidence when
remote work is authorized, and re-sign code/image/cost profiles before live use.
No push, public post, cloud mutation, actual AI call or production change is
authorized merely by passing these checks.
