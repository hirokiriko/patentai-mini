import { createHash } from "node:crypto";

import type {
  PatentWatchAnalysisJson,
  PatentWatchCursor,
  PatentWatchErrorCode,
  PatentWatchReviewStatus,
  PatentWatchSettingInput,
} from "./types";

const YYYYMMDD_PATTERN = /^[0-9]{8}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/u;
const REVIEW_STATUSES = new Set<PatentWatchReviewStatus>([
  "unreviewed",
  "reviewed",
]);

const STABLE_ERROR_CODES = new Set<PatentWatchErrorCode>([
  "invalid_watch_setting",
  "invalid_watch_review_status",
  "invalid_watch_run_request",
  "case_not_found",
  "watch_not_configured",
  "watch_disabled",
  "watch_claims_not_ready",
  "watch_run_in_progress",
  "watch_run_not_found",
  "watch_finding_not_found",
  "watch_corpus_unavailable",
  "watch_unavailable",
  "watch_analysis_failed",
  "watch_internal_error",
]);

const LEGAL_CONCLUSION_PATTERNS = [
  /拒絶/u,
  /権利化/u,
  /登録(?:でき|され|不可|可能|不能)/u,
  /特許性/u,
  /新規性/u,
  /進歩性/u,
  /無効/u,
  /侵害/u,
  /特許(?:権)?(?:に|と)?な(?:る|らな|り得|れな)/u,
  /特許(?:権)?[^。\n]{0,30}付与/u,
  /特許(?:を受け|取得|が成立)[^。\n]*(?:できな|できる|不可|困難|可能|しない|する)/u,
  /\b(?:patentab(?:le|ility)|unpatentable|not\s+patentable|novelty|lacks?\s+novelty|inventive\s+step|obvious(?:ness)?|patent\s+(?:is\s+)?invalid|invalidity|infring(?:e|ement)|reject(?:ed|ion)|allowable)\b/iu,
  /\b(?:patents?|claims?)\s+(?:(?:is|are|will\s+be)\s+)?(?:not\s+)?(?:invalid|valid|granted|rejected)\b/iu,
  /\bwill\s+(?:be\s+)?(?:granted|rejected)\b/iu,
] as const;

const PUBLIC_ANALYSIS_FALLBACK =
  "重なり候補を整理した結果です。人による確認が必要です";

export class PatentWatchDomainError extends Error {
  readonly code: PatentWatchErrorCode;

  constructor(code: PatentWatchErrorCode) {
    super(`Patent watch operation failed: ${code}`);
    this.name = "PatentWatchDomainError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isValidPatentWatchDate(value: unknown): value is string {
  if (typeof value !== "string" || !YYYYMMDD_PATTERN.test(value)) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= daysInMonth[month - 1];
}

type PatentWatchTimestampParts = {
  epochSecond: number;
  microsecond: number;
};

function patentWatchTimestampParts(
  value: unknown,
): PatentWatchTimestampParts | null {
  if (typeof value !== "string") return null;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    !isValidPatentWatchDate(
      `${match[1]}${match[2]}${match[3]}`,
    ) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  let offsetMinutes = 0;
  if (match[8] !== "Z") {
    const offset = match[8];
    const sign = offset[0] === "+" ? 1 : -1;
    const compact = offset.slice(1).replace(":", "");
    const offsetHour = Number(compact.slice(0, 2));
    const offsetMinute = compact.length === 2 ? 0 : Number(compact.slice(2));
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = sign * (offsetHour * 60 + offsetMinute);
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  const utcMillis = date.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(utcMillis)) return null;

  return {
    epochSecond: Math.trunc(utcMillis / 1_000),
    microsecond: Number((match[7] ?? "").padEnd(6, "0")),
  };
}

export function isValidPatentWatchTimestamp(value: unknown): value is string {
  return patentWatchTimestampParts(value) !== null;
}

export function comparePatentWatchTimestamps(
  left: string,
  right: string,
): number {
  const leftParts = patentWatchTimestampParts(left);
  const rightParts = patentWatchTimestampParts(right);
  if (leftParts === null || rightParts === null) {
    throw new PatentWatchDomainError("watch_unavailable");
  }
  if (leftParts.epochSecond !== rightParts.epochSecond) {
    return leftParts.epochSecond < rightParts.epochSecond ? -1 : 1;
  }
  if (leftParts.microsecond === rightParts.microsecond) return 0;
  return leftParts.microsecond < rightParts.microsecond ? -1 : 1;
}

export function validatePatentWatchSettingInput(
  value: unknown,
): PatentWatchSettingInput {
  if (!isRecord(value)) {
    throw new PatentWatchDomainError("invalid_watch_setting");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes("enabled") ||
    !keys.includes("monitoringFromDate") ||
    typeof value.enabled !== "boolean" ||
    !isValidPatentWatchDate(value.monitoringFromDate)
  ) {
    throw new PatentWatchDomainError("invalid_watch_setting");
  }
  return {
    enabled: value.enabled,
    monitoringFromDate: value.monitoringFromDate,
  };
}

export function parsePatentWatchCursor(
  runUpdatedAt: unknown,
  importId: unknown,
): PatentWatchCursor | null {
  if (runUpdatedAt === null && importId === null) return null;
  if (
    typeof runUpdatedAt !== "string" ||
    !isValidPatentWatchTimestamp(runUpdatedAt) ||
    !isPositiveSafeInteger(importId)
  ) {
    throw new PatentWatchDomainError("watch_unavailable");
  }
  return { runUpdatedAt, importId };
}

export function comparePatentWatchCursors(
  left: PatentWatchCursor,
  right: PatentWatchCursor,
): number {
  const timestampComparison = comparePatentWatchTimestamps(
    left.runUpdatedAt,
    right.runUpdatedAt,
  );
  if (timestampComparison !== 0) return timestampComparison;
  return left.importId - right.importId;
}

export function canonicalSourceIdentityJson(
  publicationNumber: string,
  contentSha256: string,
): string {
  if (
    publicationNumber.length === 0 ||
    publicationNumber.trim() !== publicationNumber ||
    !SHA256_PATTERN.test(contentSha256)
  ) {
    throw new PatentWatchDomainError("watch_corpus_unavailable");
  }
  return JSON.stringify({ publicationNumber, contentSha256 });
}

export function createPatentWatchSourceKey(
  publicationNumber: string,
  contentSha256: string,
): string {
  return createHash("sha256")
    .update(
      canonicalSourceIdentityJson(publicationNumber, contentSha256),
      "utf8",
    )
    .digest("hex");
}

export function validatePatentWatchReviewInput(value: unknown): {
  reviewStatus: PatentWatchReviewStatus;
} {
  if (!isRecord(value)) {
    throw new PatentWatchDomainError("invalid_watch_review_status");
  }
  const keys = Object.keys(value);
  if (
    keys.length !== 1 ||
    keys[0] !== "reviewStatus" ||
    !REVIEW_STATUSES.has(value.reviewStatus as PatentWatchReviewStatus)
  ) {
    throw new PatentWatchDomainError("invalid_watch_review_status");
  }
  return { reviewStatus: value.reviewStatus as PatentWatchReviewStatus };
}

export function validatePatentWatchRunRequestBody(
  value: string | Uint8Array | ArrayBuffer | null | undefined,
): void {
  if (
    value === null ||
    value === undefined ||
    (typeof value === "string" && value.length === 0) ||
    (value instanceof Uint8Array && value.byteLength === 0) ||
    (value instanceof ArrayBuffer && value.byteLength === 0)
  ) {
    return;
  }
  throw new PatentWatchDomainError("invalid_watch_run_request");
}

export function isPatentWatchErrorCode(
  value: unknown,
): value is PatentWatchErrorCode {
  return (
    typeof value === "string" &&
    STABLE_ERROR_CODES.has(value as PatentWatchErrorCode)
  );
}

export function stablePatentWatchErrorCode(
  error: unknown,
): PatentWatchErrorCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isPatentWatchErrorCode(error.code)
  ) {
    return error.code;
  }
  return "watch_internal_error";
}

export function containsLegalConclusion(value: string): boolean {
  return LEGAL_CONCLUSION_PATTERNS.some((pattern) => pattern.test(value));
}

/** 公開レスポンスやreportへ内部識別子・local pathを持ち込まない。 */
export function sanitizePatentWatchPublicText(value: string): string {
  return value
    .replace(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/giu, "[非表示]")
    .replace(/\bfile:\/\/[^\s,;]*/giu, "[非表示]")
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n,;|]*/gu, "[非表示]")
    .replace(/\\\\[^\\/\r\n,;|]+[\\/][^\r\n,;|]*/gu, "[非表示]")
    .replace(
      /\/(?:home|Users|tmp|var|private|opt|mnt|root|app|workspace|etc|srv|usr)\/[^\s,;]*/gu,
      "[非表示]",
    )
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s@]+@[^\s]+/giu,
      "[非表示]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[非表示]")
    .replace(
      /\b(?:(?:[A-Z0-9]+_)+(?:API_KEY|KEY|TOKEN|PASSWORD|SECRET|CONNECTION_STRING)|API_KEY|TOKEN|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/giu,
      "[非表示]",
    );
}

export function boundedPatentWatchPublicText(
  value: string,
  maxCharacters: number,
): string {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new PatentWatchDomainError("watch_internal_error");
  }
  return Array.from(sanitizePatentWatchPublicText(value))
    .slice(0, maxCharacters)
    .join("");
}

function normalizeSensitiveText(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function containsForbiddenFullText(
  value: string,
  forbiddenFullTexts: readonly string[],
): boolean {
  const normalizedValue = normalizeSensitiveText(value);
  if (normalizedValue.length === 0) return false;
  return forbiddenFullTexts.some((forbidden) => {
    const normalizedForbidden = normalizeSensitiveText(forbidden);
    return (
      normalizedForbidden.length > 0 &&
      normalizedValue.includes(normalizedForbidden)
    );
  });
}

function containsForbiddenAggregate(
  values: readonly string[],
  forbiddenFullTexts: readonly string[],
): boolean {
  const compactAggregate = normalizeSensitiveText(values.join(""))
    .replace(/\s+/gu, "");
  if (compactAggregate.length === 0) return false;
  return forbiddenFullTexts.some((forbidden) => {
    const compactForbidden = normalizeSensitiveText(forbidden)
      .replace(/\s+/gu, "");
    return (
      compactForbidden.length > 0 &&
      compactAggregate.includes(compactForbidden)
    );
  });
}

function safeAnalysisList(
  values: readonly string[],
  forbiddenFullTexts: readonly string[],
): string[] {
  return values
    .filter(
      (value) =>
        !containsLegalConclusion(value) &&
        !containsForbiddenFullText(value, forbiddenFullTexts),
    )
    .map((value) => sanitizePatentWatchPublicText(value).trim())
    .filter(Boolean)
    .slice(0, 50)
    .map((value) => Array.from(value).slice(0, 500).join(""));
}

export function sanitizePatentWatchAnalysis(
  value: PatentWatchAnalysisJson,
  forbiddenFullTexts: readonly string[] = [],
): PatentWatchAnalysisJson {
  const explanation =
    containsLegalConclusion(value.explanation) ||
    containsForbiddenFullText(value.explanation, forbiddenFullTexts)
    ? PUBLIC_ANALYSIS_FALLBACK
    : sanitizePatentWatchPublicText(value.explanation).trim();
  const matchedElements = safeAnalysisList(
    value.matchedElements,
    forbiddenFullTexts,
  );
  const unmatchedElements = safeAnalysisList(
    value.unmatchedElements,
    forbiddenFullTexts,
  );
  const safeExplanation =
    Array.from(explanation).slice(0, 2_000).join("") ||
    PUBLIC_ANALYSIS_FALLBACK;
  if (
    containsForbiddenAggregate(
      [...matchedElements, ...unmatchedElements, safeExplanation],
      forbiddenFullTexts,
    )
  ) {
    return {
      matchedElements: [],
      unmatchedElements: [],
      explanation: PUBLIC_ANALYSIS_FALLBACK,
    };
  }
  return {
    matchedElements,
    unmatchedElements,
    explanation: safeExplanation,
  };
}

export function serializePatentWatchAnalysis(
  value: PatentWatchAnalysisJson,
  forbiddenFullTexts: readonly string[] = [],
): string {
  const safe = sanitizePatentWatchAnalysis(value, forbiddenFullTexts);
  return JSON.stringify({
    matchedElements: safe.matchedElements,
    unmatchedElements: safe.unmatchedElements,
    explanation: safe.explanation,
  });
}
