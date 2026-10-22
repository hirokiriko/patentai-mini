import { createHash } from "node:crypto";

// Provider errors may echo input or credentials. Retain only fixed vocabulary
// and a complete-body hash, never arbitrary messages, codes, parameters or URLs.
const codes = new Set(["invalid_json_schema", "invalid_request_error", "invalid_parameter", "unsupported_parameter",
  "unsupported_value", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota", "content_filter", "server_error"]);
const types = new Set(["invalid_request_error", "rate_limit_error", "server_error", "authentication_error", "permission_error"]);
const parameters = new Set(["text.format", "text.format.schema", "response_format", "max_output_tokens", "model", "input", "reasoning.effort", "service_tier"]);

/** Diagnostic read only. It never establishes known usage or allows retry. */
export async function providerFailureMetadata(response: Response, signal?: AbortSignal | null) {
  const result: { status: number; bodyState: string; bodyBytes: number; bodySHA256: string | null;
    code: string | null; type: string | null; param: string | null; usageKnown: false } = {
    status: response.status, bodyState: "absent", bodyBytes: 0, bodySHA256: null,
    code: null, type: null, param: null, usageKnown: false,
  };
  if (!response.body) return result;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined, complete = false;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(Error("provider_failure_read_stopped"));
    timer = setTimeout(abort, 1000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), stopped]);
      if (next.done) { complete = true; break; }
      result.bodyBytes += next.value.byteLength;
      if (result.bodyBytes > 16384) { result.bodyState = "over_limit"; return result; }
      chunks.push(next.value);
    }
    const raw = Buffer.concat(chunks);
    result.bodySHA256 = createHash("sha256").update(raw).digest("hex");
    result.bodyState = "complete";
    try {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      const error = body?.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) result.bodyState = "unrecognized_json";
      else {
        if (typeof error.code === "string" && codes.has(error.code)) result.code = error.code;
        if (typeof error.type === "string" && types.has(error.type)) result.type = error.type;
        if (typeof error.param === "string" && parameters.has(error.param)) result.param = error.param;
      }
    } catch { result.bodyState = "invalid_json"; }
  } catch { result.bodyState = "read_stopped"; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => undefined);
  }
  return result;
}
