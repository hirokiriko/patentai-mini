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
