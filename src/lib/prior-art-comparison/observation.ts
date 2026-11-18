import type { AiRequestTimingEvent } from "../ai-request-timing";
import { isPatentWatchStopReason } from "../patent-watch/diagnostic";
import type { ComparisonFailureKind, ComparisonStage } from "./failure";
import { LIMITS } from "./limits";

const events = ["reservation_ack", "callback_scheduled", "callback_started", "callback_completed", "callback_rejected",
  "source_started", "generation_started", "review_started", "execution_completed", "execution_rejected",
  "source_audit_save_begin", "source_audit_saved", "source_audit_unconfirmed",
  "result_save_begin", "result_saved", "result_save_unconfirmed", "result_readback_confirmed",
  "failure_save_begin", "failure_saved", "failure_save_unconfirmed", "request_timing"] as const;
type Event = typeof events[number];
type Details = { stage?: ComparisonStage; kind?: ComparisonFailureKind; answers?: number; tasks?: number;
  timing?: AiRequestTimingEvent };
const stages = ["source_reading", "generation", "review"];
const kinds = ["timeout", "transport_unknown", "output_incomplete", "usage_invalid", "protocol_invalid", "review_rejected"];
const phases = ["request_enter", "reservation_begin", "reservation_ack", "request_deadline_armed", "transport_begin",
  "headers_received", "body_begin", "body_complete", "abort", "stopped", "terminal"];
const abortSources = ["request", "caller", "comparison", "managed"];
const milliseconds = (value: number) => Number.isFinite(value) ? Math.min(86_400_000, Math.max(0, Math.floor(value))) : 0;

/** Optional console evidence, not a state transition or a billing/worker ledger.
 * Each layer has its own monotonic origin. Only UUID, fixed labels and bounded
 * numbers cross this boundary; no exception, source, request or answer is logged. */
export function comparisonObservation(operationId: string) {
  const started = performance.now();
  let active = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId), count = 0;
  return {
    emit(event: Event, details: Details = {}) {
      if (!active || count >= 1024 || !events.includes(event)) return;
      count++;
      try {
        const fields: Record<string, string | number | null> = {};
        if (details.stage && stages.includes(details.stage)) fields.stage = details.stage;
        if (details.kind && kinds.includes(details.kind)) fields.kind = details.kind;
        for (const key of ["answers", "tasks"] as const) {
          const value = details[key];
          if (Number.isSafeInteger(value) && value! >= 0 && value! <= 10_000) fields[key] = value!;
        }
        const timing = details.timing;
        if (timing && Number.isSafeInteger(timing.attempt) && timing.attempt >= 1 && timing.attempt <= LIMITS.sourceRequests + 2 && phases.includes(timing.phase)) {
          fields.attempt = timing.attempt; fields.phase = timing.phase;
          fields.requestElapsedMs = milliseconds(timing.elapsedMs);
          fields.abortSource = timing.abortSource && abortSources.includes(timing.abortSource) ? timing.abortSource : null;
          if (timing.phase === "stopped" && isPatentWatchStopReason(timing.stopReason)) fields.stopReason = timing.stopReason;
        }
        void Promise.resolve(console.info("prior_art_comparison_diagnostic", JSON.stringify({
          operationId, event, elapsedMs: milliseconds(performance.now() - started), ...fields,
        }))).catch(() => {});
      } catch { /* Diagnostic loss must not change the original result. */ }
    },
    close() { active = false; },
  };
}
