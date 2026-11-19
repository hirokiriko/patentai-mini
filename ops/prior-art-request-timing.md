# Prior-art request timing

`withAiRequestTiming` installs a private observation scope for a bounded AI
operation. A private server preload can instead explicitly install a process
observer with `installAiRequestTimingObserver`; separately bundled server modules
share its versioned registry. Dispose it when that process stops. Environment
variables do not enable a private observer. The normal comparison executor now
installs its own bounded console observation scope described below; this does
not establish that an earlier deployment installed or retained an observer.

Each attempt emits at most 32 events: request entry, managed reservation
begin/ACK when applicable, request deadline armed, transport begin, headers
received, body begin/complete, first observed abort, first fixed stop reason and
terminal. Only the attempt, fixed phase, bounded monotonic elapsed milliseconds,
fixed abort-source label and allowlisted stop reason
are supplied. Request/response bodies, URLs, headers and exceptions are never
passed to the observer. An enclosing private transport adapter records its own
admission and durable reservation intervals separately from native HTTP timing.

`caller` identifies the supplied signal, which can itself combine deadlines; it
does not establish user cancellation. `request`, `comparison` and `managed`
identify signals owned by the budget. A headers-wait timeout does not establish
whether the provider accepted, completed or billed the request. Keep unknown
usage reserved. Timings from separate processes use separate monotonic origins.

Observation does not alter request serialization, models, reasoning, deadlines,
retries, usage checks or QA. Observer exceptions are isolated. The private caller
must durably record and read back collected events, stop on ambiguous writes,
and close the observation scope so late callbacks cannot affect a later run.
Neither instrumentation nor a passing fictional test proves real-AI quality.

## Normal comparison diagnostics

The existing application console receives `prior_art_comparison_diagnostic`
records for the accepted operation UUID. Route records distinguish reservation
ACK, callback scheduling, callback start and callback completion/rejection.
Executor records distinguish source extraction, generation, review, execution
completion/rejection and the per-attempt timings above. Repository records
distinguish audit/result/failure write begin, successful ACK, uncertain write,
and confirmed result readback after an uncertain write. `saved` is emitted only
after the existing transaction resolves; it is not emitted merely on write intent.
No additional DB writes, AI calls, retries or reservation transitions are added.

Only the operation UUID, fixed event/stage/failure labels, bounded counters and
elapsed milliseconds are logged. Sources, answers, source-task IDs, URLs, headers,
credentials and raw exceptions are excluded. Each layer has its own elapsed-time
origin and closes its observer at exit. Do not subtract elapsed values from
different layers. Attempt ordinals include source requests plus generation and
review. An enclosing private observer is forwarded the same timing events while
it remains active; throwing observers cannot change the comparison outcome.

Use the existing console-log sink, restricted by the exact deployment revision,
operation UUID and execution interval. Retrieve and retain the raw log response
privately, with its query/observation time and digest. Check actual retention,
ingestion and access before depending on it; console emission is not a durable
log ACK. Missing rows can mean lost or unavailable observation. They never prove
no send, no execution or a terminated worker. No new logging infrastructure or
diagnostic-setting change is required by this code.

For an uncertain operation, correlate request timing with existing usage rows,
the authenticated source-audit snapshot and saved-result lookup. A request
`terminal` event describes the local HTTP wrapper, not provider termination or
billing. `callback_rejected` can coexist with a durable `reserved` state for
timeout, transport or usage uncertainty. Keep the reservation and full unknown
cost hold. An OFF revision stops new admissions; it alone does not prove the old
revision, callback or provider work has stopped. Do not replay the operation.

Local executor deadlines, AI per-request/comparison signals, DB audit/result
ACK and process exit are separate boundaries. Audit/result DB awaits currently
have no whole-write bound established by the comparison signal; the DB lock
timeout only bounds lock acquisition. Diagnose the last observed stage before
changing a deadline. Before any separately authorized new comparison, establish
the old cloud operation's termination or the applicable runbook isolation
conditions. A new diagnostic deployment cannot reconstruct events that an old
deployment never recorded.

## Original signed diagnostic trial allowance

The separately approved diagnostic continuation uses one new signed
`comparisonDiagnosticsEarmark` after the exact active forward25/cap124000
predecessor. The decoder admits forward26/cap136000 only with the unchanged
earlier earmarks, new approval and epoch digests, exact predecessor plan/profile
and the same November deadline. It adds base4742 (AI2000, image1115, other1227,
storage400) and remaining pool525, totaling5267. All earlier operations,
UNKNOWN reservations and the separate OWNER allowance remain intact.

Stop25 is inert for this supplement. Rebinding, stopping or reactivation cannot
replenish a consumed unit. That original diagnostic-only addition did not issue forward27 or fund the
conditional corrective trial in advance. Code support and the monthly ceiling
are not execution authority: the existing Local approval, actual retained
state, exact candidate, required CI/review and old-worker termination or
applicable runbook isolation must be bound before a new comparison.

## Bounded HTTP status observation

The `headers_received` timing event additionally records `httpStatus` only for
an integer from 100 through 599. The comparison console projection preserves
that number; body, headers, status text and exception details are not logged.
The existing diagnostic query must explicitly project
`HttpStatus=toint(Data.httpStatus)` before this field is available in its output.
Old deployments and old collected projections cannot reconstruct a missing
status. A non-2xx status alone does not identify a schema, quota or provider
failure. It does not establish billing, worker termination or permission for
another comparison. The existing stop, no-retry and UNKNOWN hold rules apply.


## Separately signed conditional corrective allowance

The November decoder supports one exact successor to the active diagnostic
forward26/cap136000 plan: `comparisonCorrectiveEarmark`, forward27, with the
same cap136000. It adds AI3000, image1115, other1227 and storage400 to the base,
plus525 to the existing remaining pool:6267 total. Earlier earmarks, UNKNOWN
operations, OWNER allowance, recovery/storage pools and the November deadline
remain unchanged. The retained month26 forecast129147 plus6267 is135414,
leaving586 under the existing cap.

The transition requires the exact previous plan and active profile, a new
approval digest and epoch, and unchanged earlier reservations. Stop26 is inert
for this supplement. Rebinding, stopping or reactivation cannot replenish it.
No forward28 or later allowance is supported by this change.

This decoder change does not issue a signed allowance or decide execution
eligibility. The existing conditional approval, known quality or concrete
technical failure, required source correction and verification, latest CI and
independent review, cloud termination or applicable isolation, cleanup and
full retained holds still need their existing runtime evidence. No old
operation is resent and no historical response is repaired.

### 未承認の次回予算分岐（署名適用は承認後のみ）

比較prompt修正の追加案は、既存の署名済みforward27からcomparisonPromptRepairEarmarkを追加するforward28（AI 2000円、追加5267円、製品月次上限142000円）と、その実行結果に基づく具体修正・回帰・最新CI・独立レビュー後にのみcomparisonPromptCorrectiveEarmarkを追加するforward29（AI 3000円、追加6267円、製品月次上限148000円）です。このコードの存在は追加承認や実行権限を意味しません。署名適用は原文の追加承認と対象版・実終端・実台帳の照合後に限ります。

各遷移は直前plan/profileのdigest、新しいownerApproval/repairEpoch、元と同じ期限を要求します。全既存earmark・既予約・UNKNOWN・OWNER別枠を保持し、停止forward27/28と再bindは追加枠を補充しません。baseは各4742/5742円、remaining poolは各525円のみ追加します。未承認の署名発行・配備・AI送信は行いません。
