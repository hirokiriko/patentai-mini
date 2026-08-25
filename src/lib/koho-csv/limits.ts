import { createIssue } from "./issues";
import type { KohoCsvIssue, KohoCsvLimits } from "./types";

export const KOHO_CSV_LIMIT_FIELDS = [
  "maxCsvBytes",
  "maxRecords",
  "maxColumnsPerRecord",
  "maxCellCharacters",
  "maxTotalCharacters",
  "maxRepeatedItemsPerRecord",
] as const satisfies readonly (keyof KohoCsvLimits)[];

export type KohoCsvLimitField = (typeof KOHO_CSV_LIMIT_FIELDS)[number];

export interface CodePointTotalSuccess {
  ok: true;
  total: number;
  addition: number;
}

export interface CodePointTotalExceeded {
  ok: false;
  total: number;
  addition: number;
}

export type CodePointTotalResult =
  | CodePointTotalSuccess
  | CodePointTotalExceeded;

export function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

/** Validate every required limit without supplying an implicit default. */
export function validateLimits(limits: KohoCsvLimits): KohoCsvIssue[] {
  if (limits === null || typeof limits !== "object") {
    return [createIssue("invalid_limits", { field: "limits" })];
  }

  const issues: KohoCsvIssue[] = [];
  for (const field of KOHO_CSV_LIMIT_FIELDS) {
    if (!isPositiveSafeInteger(limits[field])) {
      issues.push(createIssue("invalid_limits", { field }));
    }
  }
  return issues;
}

/** Run only after `validateLimits`, following the Issue's validation order. */
export function checkCsvByteLimit(
  bytes: Uint8Array,
  limits: KohoCsvLimits,
): KohoCsvIssue[] {
  if (!isPositiveSafeInteger(limits.maxCsvBytes)) {
    return [createIssue("invalid_limits", { field: "maxCsvBytes" })];
  }
  if (bytes.byteLength > limits.maxCsvBytes) {
    return [createIssue("csv_byte_limit_exceeded", { field: "maxCsvBytes" })];
  }
  return [];
}

/** Count Unicode code points, not UTF-8 bytes, UTF-16 units, or graphemes. */
export function countUnicodeCodePoints(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    if (
      first >= 0xd800 &&
      first <= 0xdbff &&
      index + 1 < value.length
    ) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        index += 1;
      }
    }
    count += 1;
  }
  return count;
}

/**
 * Overflow-safe limit comparison. Invalid accounting state is treated as an
 * exceedance instead of allowing an unsafe addition.
 */
export function wouldExceedSafeLimit(
  used: number,
  addition: number,
  limit: number,
): boolean {
  if (
    !Number.isSafeInteger(used) ||
    used < 0 ||
    !Number.isSafeInteger(addition) ||
    addition < 0 ||
    !isPositiveSafeInteger(limit) ||
    used > limit
  ) {
    return true;
  }
  return addition > limit - used;
}

/** Count `value` and add it only when the configured total remains bounded. */
export function addToCodePointTotal(
  used: number,
  value: string,
  limit: number,
): CodePointTotalResult {
  const addition = countUnicodeCodePoints(value);
  if (wouldExceedSafeLimit(used, addition, limit)) {
    return { ok: false, total: used, addition };
  }
  return { ok: true, total: used + addition, addition };
}
