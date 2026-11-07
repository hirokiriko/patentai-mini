import { createHash } from "node:crypto";
import { NoObjectGeneratedError } from "ai";
import { describe, expect, it } from "vitest";
import { captureReviewSdkFailure, REVIEW_SDK_TEXT_JSON_BYTES, validateReviewSdkFailure } from "./review-sdk-failure";
import { retainReviewFailure, takeReviewFailure, validateReviewFailureEvidence } from "./review-failure-audit";
import { ComparisonExecutionError } from "./failure";

const secret = "FICTIONAL_DIAGNOSTIC_SECRET_SENTINEL";
function sdkError(text?: string, finishReason: "stop" | "length" = "stop") {
  const response = { id: "fictional", timestamp: new Date(0), modelId: "fictional", headers: { authorization: secret }, body: { private: secret } };
  return new NoObjectGeneratedError({ text, finishReason,
    response,
    usage: { inputTokens: 100, outputTokens: 30, totalTokens: 130, inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 30, reasoningTokens: 0 } },
    message: secret, cause: Error(secret) });
}
describe("bounded private SDK failure evidence", () => {
  it("only reads model text and normalized finishReason, never the exception envelope", () => {
    const error = sdkError('{"incomplete":');
    for (const key of ["response", "usage", "message", "cause", "stack", "request", "headers"])
      Object.defineProperty(error, key, { get() { throw Error(secret); }, configurable: true });
    const diagnostic = captureReviewSdkFailure(error)!;
    expect(diagnostic).toMatchObject({ kind: "no_object_generated", finishReason: "stop",
      text: { status: "captured", value: '{"incomplete":' } });
    expect(JSON.stringify(diagnostic)).not.toContain(secret);
    expect(validateReviewSdkFailure(diagnostic)).toEqual(diagnostic);
  });
  it.each([undefined, ""])("distinguishes missing text from an exact empty response: %s", text => {
    const d = captureReviewSdkFailure(sdkError(text))!;
    expect(d.text.status).toBe(text === undefined ? "unavailable" : "captured");
    expect(validateReviewSdkFailure(d)).toEqual(d);
  });
  it.each(["x".repeat(REVIEW_SDK_TEXT_JSON_BYTES - 2), "界".repeat((REVIEW_SDK_TEXT_JSON_BYTES - 3) / 3),
    "\n".repeat((REVIEW_SDK_TEXT_JSON_BYTES - 2) / 2)])("preserves exact text up to the JSON byte bound", text => {
    const d = captureReviewSdkFailure(sdkError(text))!;
    expect(d.text).toMatchObject({ status: "captured", value: text, bytes: Buffer.byteLength(text, "utf8"),
      jsonBytes: Buffer.byteLength(JSON.stringify(text), "utf8"), sha256: createHash("sha256").update(text).digest("hex") });
    expect(Buffer.byteLength(JSON.stringify(d), "utf8")).toBeLessThan(64_000);
    expect(validateReviewSdkFailure(d)).toEqual(d);
  });
  it.each(["x".repeat(REVIEW_SDK_TEXT_JSON_BYTES), "界".repeat(20_001), "\n".repeat(30_000)])("omits all oversized text, never a misleading truncated response", text => {
    const d = captureReviewSdkFailure(sdkError(text))!;
    expect(d.text).toMatchObject({ status: "omitted", reason: "size_limit", bytes: Buffer.byteLength(text, "utf8"),
      jsonBytes: Buffer.byteLength(JSON.stringify(text), "utf8"), sha256: createHash("sha256").update(text).digest("hex") });
    expect(d.text).not.toHaveProperty("value");
    expect(validateReviewSdkFailure(d)).toEqual(d);
  });
  it.each(['{"api_key":"' + secret + '"}', "Authorization: Bearer " + secret, "password=" + secret,
    "postgresql://fictional:" + secret + "@example.invalid/db", "https://example.invalid/?sig=" + secret,
    "-----BEGIN PRIVATE KEY-----" + secret, '{"\\u0061pi_key":"' + secret + '"}', JSON.stringify('{"password":"' + secret + '"}')])("omits credential-shaped model text completely", text => {
    const d = captureReviewSdkFailure(sdkError(text))!;
    expect(d.text).toMatchObject({ status: "omitted", reason: "sensitive_content" });
    expect(JSON.stringify(d)).not.toContain(secret);
    expect(validateReviewSdkFailure(d)).toEqual(d);
  });
  it("rejects altered metadata, unknown keys, fabricated capture hashes and unfiltered secret text", () => {
    const good = captureReviewSdkFailure(sdkError("{}"))!;
    expect(() => validateReviewSdkFailure({ ...good, response: { body: secret } })).toThrow();
    expect(() => validateReviewSdkFailure({ ...good, finishReason: secret })).toThrow();
    expect(() => validateReviewSdkFailure({ ...good, text: { ...good.text, sha256: "a".repeat(64) } })).toThrow();
    const text = "password=" + secret;
    expect(() => validateReviewSdkFailure({ ...good, text: { status: "captured", value: text,
      bytes: Buffer.byteLength(text), jsonBytes: Buffer.byteLength(JSON.stringify(text)), sha256: createHash("sha256").update(text).digest("hex") } })).toThrow();
  });
  it("does not inspect generic errors or replace a failure when optional accessors throw", () => {
    expect(captureReviewSdkFailure(new Error(secret))).toBeUndefined();
    const error = sdkError("{}");
    Object.defineProperty(error, "text", { get() { throw Error(secret); } });
    expect(captureReviewSdkFailure(error)).toBeUndefined();
    const altered = sdkError("{}");
    Object.defineProperty(altered, "finishReason", { value: secret });
    expect(captureReviewSdkFailure(altered)?.finishReason).toBe("unknown");
  });
  it.each(["protocol_invalid", "output_incomplete"] as const)("retains SDK evidence privately for known %s without altering the terminal error", kind => {
    const error = new ComparisonExecutionError("review", kind);
    const d = captureReviewSdkFailure(sdkError("{}", kind === "output_incomplete" ? "length" : "stop"));
    retainReviewFailure(error, { step: "sdk_object", inputs: { inputDigest: "a".repeat(64) }, selection: {},
      generation: { api_key: secret }, review: d });
    const kept = takeReviewFailure(error)!;
    expect(kept.generation).toMatchObject({ status: "omitted", reason: "sensitive_content" });
    expect(validateReviewFailureEvidence(kept)).toEqual(kept);
    expect(JSON.stringify(kept)).not.toContain(secret);
    expect(error).toMatchObject({ stage: "review", kind });
    expect(JSON.stringify(error)).not.toMatch(/no_object_generated|finishReason|inputDigest|sha256/);
    expect(takeReviewFailure(error)).toBeUndefined();
  });
  it("leaves unknown failures and invalid diagnostic contexts unchanged", () => {
    for (const kind of ["timeout", "usage_invalid", "transport_unknown", "review_rejected"] as const) {
      const error = new ComparisonExecutionError("review", kind);
      retainReviewFailure(error, { step: "sdk_object", inputs: {}, selection: {}, generation: {}, review: captureReviewSdkFailure(sdkError("{}")) });
      expect(takeReviewFailure(error)).toBeUndefined();
      expect(error.kind).toBe(kind);
    }
    const error = new ComparisonExecutionError("review", "protocol_invalid");
    retainReviewFailure(error, { step: "sdk_object", inputs: {}, selection: {}, generation: {}, review: { response: secret } });
    expect(takeReviewFailure(error)).toBeUndefined();
    expect(error.kind).toBe("protocol_invalid");
  });
});
