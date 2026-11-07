import { createHash } from "node:crypto";
import type { ComparisonExecutionError } from "./failure";
import { hasSensitiveDiagnosticText, validateReviewSdkFailure } from "./review-sdk-failure";

export type ReviewFailureStep = "sdk_object" | "assessment" | "coverage_render" | "final_answer" | "saved_envelope";
export type ReviewFailureContext = { step: ReviewFailureStep; inputs: unknown; selection: unknown; generation: unknown; review: unknown };
type CapturedValue = { bytes: number; sha256: string } & (
  { status: "captured"; value: unknown } | { status: "omitted"; reason: "size_limit" | "sensitive_content" }
);
export type ReviewFailureEvidence = { step: ReviewFailureStep; inputs: CapturedValue; selection: CapturedValue; generation: CapturedValue; review: CapturedValue };
const limits = { inputs: 512_000, selection: 32_000, generation: 64_000, review: 64_000 } as const;
const steps: ReviewFailureStep[] = ["sdk_object", "assessment", "coverage_render", "final_answer", "saved_envelope"];
const fields = Object.keys(limits) as (keyof typeof limits)[];
// Private data must not appear when an Error is serialized by a public route,
// logger or framework. Only the repository consumes this one-shot side channel.
const evidence = new WeakMap<ComparisonExecutionError, ReviewFailureEvidence>();
function capture(value: unknown, maximum: number, screenSensitive = false): CapturedValue {
  const json = JSON.stringify(value);
  if (typeof json !== "string") throw Error("review_audit_invalid");
  const bytes = Buffer.byteLength(json, "utf8"), sha256 = createHash("sha256").update(json).digest("hex");
  if (bytes > maximum) return { status: "omitted", reason: "size_limit", bytes, sha256 };
  if (screenSensitive && hasSensitiveDiagnosticText(json)) return { status: "omitted", reason: "sensitive_content", bytes, sha256 };
  return { status: "captured", bytes, sha256, value: JSON.parse(json) };
}
export function retainReviewFailure(error: ComparisonExecutionError, context: ReviewFailureContext): void {
  const sdk = context.step === "sdk_object";
  if (error.stage !== "review" || !(sdk ? ["protocol_invalid", "output_incomplete"] : ["protocol_invalid", "review_rejected"]).includes(error.kind)) return;
  try {
    const review = sdk ? validateReviewSdkFailure(context.review) : context.review;
    evidence.set(error, { step: context.step, inputs: capture(context.inputs, limits.inputs, sdk),
      selection: capture(context.selection, limits.selection, sdk), generation: capture(context.generation, limits.generation, sdk),
      review: capture(review, limits.review) });
  } catch { /* Optional diagnostics cannot replace the original terminal failure. */ }
}
export function takeReviewFailure(error: ComparisonExecutionError): ReviewFailureEvidence | undefined {
  const value = evidence.get(error);
  evidence.delete(error);
  return value;
}
export function validateReviewFailureEvidence(raw: unknown): ReviewFailureEvidence {
  const value = raw as ReviewFailureEvidence;
  if (!value || Object.keys(value).sort().join() !== "generation,inputs,review,selection,step" || !steps.includes(value.step))
    throw Error("review_audit_invalid");
  for (const name of fields) {
    const item = value[name];
    if (!item || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw Error("review_audit_invalid");
    if (item.status === "captured") {
      if (Object.keys(item).sort().join() !== "bytes,sha256,status,value" || item.bytes > limits[name])
        throw Error("review_audit_invalid");
      const actual = capture(item.value, limits[name], value.step === "sdk_object" && name !== "review");
      if (actual.status !== "captured" || actual.bytes !== item.bytes || actual.sha256 !== item.sha256)
        throw Error("review_audit_invalid");
      if (value.step === "sdk_object" && name === "review") validateReviewSdkFailure(item.value);
    } else if (item.status !== "omitted" || !(item.reason === "size_limit" ? item.bytes > limits[name] :
      value.step === "sdk_object" && name !== "review" && item.reason === "sensitive_content" && item.bytes <= limits[name]) ||
      Object.keys(item).sort().join() !== "bytes,reason,sha256,status") throw Error("review_audit_invalid");
  }
  return structuredClone(value);
}
