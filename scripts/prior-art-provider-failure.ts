import { createHash } from "node:crypto";

// Provider errors may echo input or credentials. Retain only fixed vocabulary
// and a complete-body hash in metadata. An explicitly supplied protected Local
// sink may preserve the bounded complete body separately; never return it.
const codes = new Set(["invalid_json_schema", "invalid_request_error", "invalid_parameter", "unsupported_parameter",
  "unsupported_value", "context_length_exceeded", "rate_limit_exceeded", "insufficient_quota", "content_filter", "server_error"]);
const types = new Set(["invalid_request_error", "rate_limit_error", "server_error", "authentication_error", "permission_error"]);
const parameters = new Set(["text.format", "text.format.schema", "response_format", "max_output_tokens", "model", "input", "prompt", "reasoning.effort", "service_tier"]);

type SafeFilter = { detected?: boolean; filtered?: boolean; severity?: string };
type SafeAnnotation = { blocked?: boolean; source_type?: string;
  content_filter_results?: Record<string, SafeFilter>;
  content_filter_offsets?: Record<string, number> };
const filterCategories = ["hate", "sexual", "violence", "self_harm", "jailbreak", "indirect_attack", "protected_material_text", "protected_material_code"] as const;
const severities = new Set(["safe", "low", "medium", "high"]);
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function filterResults(value: unknown) {
  const source = object(value), result: Record<string, SafeFilter> = {};
  for (const key of filterCategories) {
    const item = object(source?.[key]);
    if (!item) continue;
    const safe: SafeFilter = {};
    if (typeof item.detected === "boolean") safe.detected = item.detected;
    if (typeof item.filtered === "boolean") safe.filtered = item.filtered;
    if (typeof item.severity === "string" && severities.has(item.severity)) safe.severity = item.severity;
    if (Object.keys(safe).length) result[key] = safe;
  }
  return Object.keys(result).length ? result : undefined;
}
function filterAnnotations(value: unknown): SafeAnnotation[] | undefined {
  if (!Array.isArray(value)) return undefined;
  // The complete bounded body remains in the existing protected sink. Unknown
  // fields, raw detections and arbitrary text must never enter metadata.
  return value.slice(0, 8).flatMap(value => {
    const item = object(value);
    if (!item) return [];
    const safe: SafeAnnotation = {};
    if (typeof item.blocked === "boolean") safe.blocked = item.blocked;
    if (item.source_type === "prompt" || item.source_type === "completion") safe.source_type = item.source_type;
    const filters = filterResults(item.content_filter_results);
    if (filters) safe.content_filter_results = filters;
    const offsets = object(item.content_filter_offsets), safeOffsets: Record<string, number> = {};
    for (const key of ["start_offset", "end_offset", "check_offset"]) {
      const offset = offsets?.[key];
      if (typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0) safeOffsets[key] = offset;
    }
    if (Object.keys(safeOffsets).length) safe.content_filter_offsets = safeOffsets;
    return Object.keys(safe).length ? [safe] : [];
  });
}

/** Diagnostic read only. It never establishes known usage or allows retry. */
export async function providerFailureMetadata(response: Response, signal?: AbortSignal | null,
  preservePrivateBody?: (bytes: Uint8Array) => Promise<void>) {
  const result: { status: number; bodyState: string; bodyBytes: number; bodySHA256: string | null;
    code: string | null; type: string | null; param: string | null; usageKnown: false;
    usagePresent?: boolean; innerCode?: "ContentFiltered";
    annotations?: SafeAnnotation[]; contentFilterResults?: Record<string, SafeFilter> } = {
    status: response.status, bodyState: "absent", bodyBytes: 0, bodySHA256: null,
    code: null, type: null, param: null, usageKnown: false,
  };
  if (!response.body) return result;
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let privateBody: Uint8Array | undefined;
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
    if (response.status === 400 && preservePrivateBody) privateBody = raw;
    try {
      const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
      result.usagePresent = object(body)?.usage !== undefined && object(body)?.usage !== null;
      const error = body?.error;
      if (!error || typeof error !== "object" || Array.isArray(error)) result.bodyState = "unrecognized_json";
      else {
        if (typeof error.code === "string" && codes.has(error.code)) result.code = error.code;
        if (typeof error.type === "string" && types.has(error.type)) result.type = error.type;
        if (typeof error.param === "string" && parameters.has(error.param)) result.param = error.param;
        const inner = object(error.innererror);
        if (inner?.code === "ContentFiltered") result.innerCode = "ContentFiltered";
        const annotations = filterAnnotations(error.content_filters);
        if (annotations?.length) result.annotations = annotations;
        const filters = filterResults(inner?.content_filter_result);
        if (filters) result.contentFilterResults = filters;
      }
    } catch { result.bodyState = "invalid_json"; }
  } catch { result.bodyState = "read_stopped"; }
  finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    if (!complete) void reader.cancel().catch(() => undefined);
  }
  if (privateBody && !signal?.aborted) {
    let privateTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([preservePrivateBody!(privateBody), new Promise<never>((_, reject) => {
        privateTimer = setTimeout(() => reject(Error("provider_failure_private_record_failed")), 1000);
      })]);
    } catch { throw Error("provider_failure_private_record_failed"); }
    finally { clearTimeout(privateTimer); }
  }
  return result;
}
