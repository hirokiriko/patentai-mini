import { NoObjectGeneratedError } from "ai";
import { aiOperationStopReason } from "../ai-operation-budget";
import { ComparisonError } from "./source";

export type ComparisonStage = "source_reading" | "generation" | "review";
export type ComparisonFailureKind = "timeout" | "transport_unknown" | "output_incomplete" | "usage_invalid" | "protocol_invalid" | "review_rejected";
/** Internal classification only. No raw response, exception, or semantic-truth
 * claim is retained. The public API still returns its fixed ai_incomplete. */
export class ComparisonExecutionError extends ComparisonError {
  constructor(readonly stage: ComparisonStage, readonly kind: ComparisonFailureKind) { super("ai_incomplete"); }
}
export function comparisonExecutionFailure(error: unknown, stage: ComparisonStage) {
  if (error instanceof ComparisonExecutionError) return error;
  const reason = aiOperationStopReason(error);
  const kind: ComparisonFailureKind = reason === "timeout" ? "timeout"
    : reason?.startsWith("usage_") ? "usage_invalid"
    : reason ? "transport_unknown"
    : NoObjectGeneratedError.isInstance(error) ? error.finishReason === "length" ? "output_incomplete" : "protocol_invalid"
    : error instanceof ComparisonError ? "protocol_invalid" : "transport_unknown";
  return new ComparisonExecutionError(stage, kind);
}
