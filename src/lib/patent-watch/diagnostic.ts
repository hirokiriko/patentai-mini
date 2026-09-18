// Shared, value-only contract. Never accept provider messages or identifiers.
export const PATENT_WATCH_STOP_REASONS = [
  "request_rejected", "input_limit", "request_limit", "timeout", "aborted",
  "upstream_http_error", "transport_error", "invalid_response", "usage_missing",
  "usage_invalid", "usage_limit", "unknown",
] as const;
export type PatentWatchStopReason = typeof PATENT_WATCH_STOP_REASONS[number];
export type PatentWatchStage = "screening" | "detail" | "unknown";
export type PatentWatchDiagnostic = { id: string; stage: PatentWatchStage; reason: PatentWatchStopReason };
export const PATENT_WATCH_DIAGNOSTIC_HEADER = "X-Patent-Watch-Diagnostic-Id";

export function isPatentWatchStopReason(value: unknown): value is PatentWatchStopReason {
  return typeof value === "string" && PATENT_WATCH_STOP_REASONS.some(reason => reason === value);
}

export function parsePatentWatchDiagnostic(value: unknown): PatentWatchDiagnostic | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["id", "stage", "reason"].includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const data = { id: descriptors.id?.value, stage: descriptors.stage?.value, reason: descriptors.reason?.value };
    if (typeof data.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(data.id) ||
        !["screening", "detail", "unknown"].includes(data.stage as string) || !isPatentWatchStopReason(data.reason)) return null;
    return { id: data.id, stage: data.stage as PatentWatchStage, reason: data.reason };
  } catch { return null; }
}

export const PATENT_WATCH_STAGE_LABELS: Record<PatentWatchStage, string> = {
  screening: "候補の絞り込み", detail: "詳細分析", unknown: "段階不明",
};
export const PATENT_WATCH_REASON_LABELS: Record<PatentWatchStopReason, string> = {
  request_rejected: "送信形式の保護条件", input_limit: "入力上限", request_limit: "送信回数上限",
  timeout: "処理期限", aborted: "処理の中断", upstream_http_error: "AIサービスのエラー応答",
  transport_error: "通信の失敗", invalid_response: "応答形式の不正", usage_missing: "利用量情報の欠損",
  usage_invalid: "利用量情報の不正", usage_limit: "利用量上限", unknown: "理由不明",
};
