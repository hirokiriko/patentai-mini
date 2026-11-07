import { createHash } from "node:crypto";
import { NoObjectGeneratedError } from "ai";

// Leave room for the allowlisted metadata within the existing 64,000-byte
// review evidence limit. This bound includes JSON escaping, not just UTF-8 text.
export const REVIEW_SDK_TEXT_JSON_BYTES = 60_000;
const finishReasons = ["stop", "length", "content-filter", "tool-calls", "error", "other", "unknown"] as const;
type FinishReason = typeof finishReasons[number];
type Fingerprint = { bytes: number; jsonBytes: number; sha256: string };
type SdkText = { status: "unavailable"; reason: "missing_text" } | Fingerprint & (
  { status: "captured"; value: string } | { status: "omitted"; reason: "size_limit" | "sensitive_content" }
);
export type ReviewSdkFailure = { kind: "no_object_generated"; finishReason: FinishReason; text: SdkText };

// Defense in depth for model text, not a guarantee of anonymization. Never read
// credentials to compare against it, redact a fragment, or serialize an Error.
export function hasSensitiveDiagnosticText(text: string): boolean {
  // Decode common JSON escapes only for screening; retained text is untouched.
  const inspected = text.replace(/\\u([a-f0-9]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\(["'\\/])/g, "$1");
  return /(?:authorization|proxy[-_]authorization|api[-_ ]?key|access[-_]token|refresh[-_]token|id[-_]token|client[-_]secret|password|passwd|accountkey|sharedaccesssignature|connectionstring|set-cookie|cookie)\s*["']?\s*[:=]/i.test(inspected)
    || /\bBearer\s+\S+|\b(?:sk-|ghp_|github_pat_|AIza)[A-Za-z0-9_-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(inspected)
    || /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|[?&](?:sig|token|code)=|(?:postgres(?:ql)?|https?):\/\/[^/\s]+:[^/\s]+@/i.test(inspected);
}
function fingerprint(text: string): Fingerprint {
  return { bytes: Buffer.byteLength(text, "utf8"), jsonBytes: Buffer.byteLength(JSON.stringify(text), "utf8"),
    sha256: createHash("sha256").update(text).digest("hex") };
}
function captureText(text: unknown): SdkText {
  if (typeof text !== "string") return { status: "unavailable", reason: "missing_text" };
  const hash = fingerprint(text);
  if (hash.jsonBytes > REVIEW_SDK_TEXT_JSON_BYTES) return { ...hash, status: "omitted", reason: "size_limit" };
  if (hasSensitiveDiagnosticText(text)) return { ...hash, status: "omitted", reason: "sensitive_content" };
  return { ...hash, status: "captured", value: text };
}
/** Only the SDK's model text and normalized finishReason may cross this boundary.
 * Arbitrary message/cause/response/request/headers/stack fields are never read. */
export function captureReviewSdkFailure(error: unknown): ReviewSdkFailure | undefined {
  try {
    if (!NoObjectGeneratedError.isInstance(error)) return undefined;
    const finishReason = finishReasons.includes(error.finishReason as FinishReason) ? error.finishReason as FinishReason : "unknown";
    return { kind: "no_object_generated", finishReason, text: captureText(error.text) };
  } catch { return undefined; } // Diagnostics must never replace the failure.
}
export function validateReviewSdkFailure(raw: unknown): ReviewSdkFailure {
  const fail = () => { throw Error("review_audit_invalid"); };
  const value = raw as ReviewSdkFailure;
  if (!value || Object.keys(value).sort().join() !== "finishReason,kind,text" || value.kind !== "no_object_generated" ||
      !finishReasons.includes(value.finishReason)) return fail();
  const text = value.text;
  if (!text) return fail();
  if (text.status === "unavailable") {
    if (Object.keys(text).sort().join() !== "reason,status" || text.reason !== "missing_text") return fail();
  } else {
    if (!Number.isSafeInteger(text.bytes) || text.bytes < 0 || !Number.isSafeInteger(text.jsonBytes) ||
        text.jsonBytes < text.bytes + 2 || !/^[a-f0-9]{64}$/.test(text.sha256)) return fail();
    if (text.status === "captured") {
      if (Object.keys(text).sort().join() !== "bytes,jsonBytes,sha256,status,value" || typeof text.value !== "string") return fail();
      const checked = captureText(text.value);
      if (checked.status !== "captured" || checked.bytes !== text.bytes || checked.jsonBytes !== text.jsonBytes || checked.sha256 !== text.sha256) return fail();
    } else if (text.status !== "omitted" || Object.keys(text).sort().join() !== "bytes,jsonBytes,reason,sha256,status" ||
        !(text.reason === "size_limit" ? text.jsonBytes > REVIEW_SDK_TEXT_JSON_BYTES :
          text.reason === "sensitive_content" && text.jsonBytes <= REVIEW_SDK_TEXT_JSON_BYTES)) return fail();
  }
  return structuredClone(value);
}
