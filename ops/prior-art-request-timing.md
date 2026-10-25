# Prior-art request timing

`withAiRequestTiming` installs a private observation scope for a bounded AI
operation. A private server preload can instead explicitly install a process
observer with `installAiRequestTimingObserver`; separately bundled server modules
share its versioned registry. Dispose it when that process stops. Public routes
and environment variables do not enable an observer.

Each attempt emits at most 32 events: request entry, managed reservation
begin/ACK when applicable, request deadline armed, transport begin, headers
received, body begin/complete, first observed abort and terminal. Only the attempt,
fixed phase, bounded monotonic elapsed milliseconds and fixed abort-source label
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
