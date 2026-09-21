import { createHash } from "node:crypto";
import { parse, type CastingContext } from "csv-parse/sync";
import type {
  DistributionDateRange, DistributionError, DistributionErrorCode, DistributionPackageType,
  DistributionRow, DistributionTableResult, DistributionWarning,
} from "./types";

export type * from "./types";
export const DISTRIBUTION_LIMITS = Object.freeze({ bytes: 1024 * 1024, rows: 10_000, fieldCharacters: 16_384 });
export const DISTRIBUTION_HEADERS = Object.freeze({
  JPA: Object.freeze(["公報発行日", "年通号", "総通号", "公開特許公開番号(最小)", "公開特許公開番号(最大)",
    "公表特許公表番号(最小)", "公表特許公表番号(最大)", "公開特許総件数(日単位)", "公表特許総件数(日単位)",
    "公報ダウンロード可否", "備考"]),
  JPB: Object.freeze(["公報発行日", "年通号", "総通号", "特許番号(最小)", "特許番号(最大)", "登録日",
    "飛び番", "飛び番回復", "総件数(日単位)", "公報ダウンロード可否", "備考"]),
});

class DistributionAbort extends Error {
  constructor(readonly detail: DistributionError) { super(detail.code); }
}
function fail(code: DistributionErrorCode, row?: number, column?: number): never {
  throw new DistributionAbort({ code, ...(row === undefined ? {} : { row }), ...(column === undefined ? {} : { column }) });
}

export function validCompactDate(value: string): boolean {
  if (!/^[0-9]{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}
function date(value: string, row: number, column: number): string {
  if (!validCompactDate(value)) fail("invalid_date", row, column);
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}
function digits(value: string, width: number, row: number, column: number): string {
  if (value.length !== width || !/^[0-9]+$/.test(value)) fail("invalid_digits", row, column);
  return value;
}
function requestedRange(input: { from?: string; to?: string }): DistributionDateRange | null {
  if (input.from === undefined && input.to === undefined) return null;
  const valid = (value: unknown): value is string => typeof value === "string" &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) && validCompactDate(value.replaceAll("-", ""));
  if (!valid(input.from) || !valid(input.to) || input.from > input.to) fail("invalid_requested_range");
  return { from: input.from, to: input.to };
}

function normalizeRow(raw: string[], ordinal: number, packageType: DistributionPackageType): DistributionRow {
  const warnings: DistributionWarning[] = [];
  const warn = (code: DistributionWarning["code"], column: number) => warnings.push({ code, row: ordinal, column });
  const numberRange = (index: number, width: number) => {
    const min = raw[index] === "" ? null : digits(raw[index], width, ordinal, index + 1);
    const max = raw[index + 1] === "" ? null : digits(raw[index + 1], width, ordinal, index + 2);
    if ((min === null) !== (max === null)) warn("missing_range_bound", index + 1);
    if (min !== null && max !== null && min > max) warn("reversed_number_range", index + 1);
    return { min, max };
  };
  const numberList = (index: number) => {
    if (raw[index] === "") return [];
    const values = raw[index].split(";");
    if (values.some(value => !/^[0-9]{7}$/.test(value))) fail("invalid_number_list", ordinal, index + 1);
    if (new Set(values).size !== values.length) warn("duplicate_number", index + 1);
    return values;
  };
  const publicationDate = date(raw[0], ordinal, 1);
  if (raw[9] !== "可" && raw[9] !== "不可") fail("invalid_availability", ordinal, 10);
  const base = {
    ordinal, raw: [...raw], publicationDate, publicationYear: raw[0].slice(0, 4),
    annualIssue: digits(raw[1], 3, ordinal, 2), cumulativeIssue: digits(raw[2], 5, ordinal, 3),
    downloadAvailability: raw[9] === "可" ? "available" as const : "unavailable" as const,
    notes: raw[10], warnings,
  };
  if (packageType === "JPA") return {
    ...base, packageType, publishedRange: numberRange(3, 6), translatedRange: numberRange(5, 6),
    dailyCounts: { published: Number(digits(raw[7], 5, ordinal, 8)), translated: Number(digits(raw[8], 5, ordinal, 9)) },
  };
  const registration = raw[5].split("～");
  if (registration.length < 1 || registration.length > 2) fail("invalid_registration_range", ordinal, 6);
  const from = date(registration[0], ordinal, 6), to = date(registration[registration.length - 1], ordinal, 6);
  if (from > to) fail("invalid_registration_range", ordinal, 6);
  return {
    ...base, packageType, patentRange: numberRange(3, 7), registrationDates: { from, to },
    skippedNumbers: numberList(6), recoveredNumbers: numberList(7),
    dailyCounts: { patents: Number(digits(raw[8], 5, ordinal, 9)) },
  };
}

/** Read one observed profile. This does not acquire publications or reconcile any import. */
export function parseDistributionTable(input: {
  bytes: Uint8Array;
  packageType: DistributionPackageType;
  from?: string;
  to?: string;
}): DistributionTableResult {
  try {
    if (!input || !(input.bytes instanceof Uint8Array)) fail("invalid_input");
    if (input.packageType !== "JPA" && input.packageType !== "JPB") fail("invalid_package_type");
    if (input.bytes.byteLength > DISTRIBUTION_LIMITS.bytes) fail("byte_limit_exceeded");
    const range = requestedRange(input);
    // Own the exact bytes used for both decoding and private provenance.
    const bytes = Uint8Array.from(input.bytes);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { fail("invalid_utf8"); }
    if (!text.length) fail("missing_header");
    const rows: DistributionRow[] = [];
    const warnings: DistributionWarning[] = [];
    const dates = new Set<string>(), annualIssues = new Set<string>(), cumulativeIssues = new Set<string>();
    let recordCount = 0;
    try {
      parse(text, {
        delimiter: ",", quote: '"', escape: '"', columns: false,
        record_delimiter: ["\r\n", "\n"], relax_column_count: true,
        trim: false, skip_empty_lines: false, skip_records_with_error: false,
        cast(value: string, context: CastingContext) {
          if (!context.quoting && value.includes("\r")) fail("invalid_csv", recordCount, context.index + 1);
          return value;
        },
        on_record(raw: string[]) {
          const ordinal = recordCount;
          if (ordinal > DISTRIBUTION_LIMITS.rows) fail("row_limit_exceeded", ordinal);
          if (raw.length !== 11) fail("column_count_mismatch", ordinal);
          for (let index = 0; index < raw.length; index++) {
            if (Array.from(raw[index]).length > DISTRIBUTION_LIMITS.fieldCharacters)
              fail("field_limit_exceeded", ordinal, index + 1);
          }
          if (ordinal === 0) {
            const header = DISTRIBUTION_HEADERS[input.packageType];
            if (raw.some((value, index) => value !== header[index])) fail("invalid_header", 0);
          } else {
            const row = normalizeRow(raw, ordinal, input.packageType);
            const annualKey = `${row.publicationYear}:${row.annualIssue}`;
            if (dates.has(row.publicationDate)) fail("duplicate_key", ordinal, 1);
            if (annualIssues.has(annualKey)) fail("duplicate_key", ordinal, 2);
            if (cumulativeIssues.has(row.cumulativeIssue)) fail("duplicate_key", ordinal, 3);
            dates.add(row.publicationDate); annualIssues.add(annualKey); cumulativeIssues.add(row.cumulativeIssue);
            if (rows.length && rows[rows.length - 1].publicationDate > row.publicationDate)
              row.warnings.push({ code: "dates_out_of_order", row: ordinal, column: 1 });
            rows.push(row); warnings.push(...row.warnings);
          }
          recordCount++;
          return null;
        },
      });
    } catch (error) {
      if (error instanceof DistributionAbort) throw error;
      // Native parser exceptions may include entire input fields. Never return them.
      fail("invalid_csv", recordCount);
    }
    if (!recordCount) fail("missing_header");
    const sortedDates = [...dates].sort();
    const observedDateRange = rows.length ? { from: sortedDates[0], to: sortedDates[sortedDates.length - 1] } : null;
    if (!observedDateRange) warnings.push({ code: "no_observed_dates" });
    else if (range && (range.from < observedDateRange.from || range.to > observedDateRange.to))
      warnings.push({ code: "requested_range_exceeds_observed_dates" });
    const selected = range ? rows.filter(row => range.from <= row.publicationDate && row.publicationDate <= range.to) : rows;
    const available = selected.filter(row => row.downloadAvailability === "available").length;
    return {
      ok: true, profileVersion: "jpo-2026-09-21", packageType: input.packageType,
      sourceSha256: createHash("sha256").update(bytes).digest("hex"), sourceRowCount: rows.length,
      observedDateRange, requestedDateRange: range,
      selectionMode: range ? "date_range" : "all_observed_rows",
      selectionStatus: selected.length ? "rows_present" : "no_rows_in_snapshot", rows: selected,
      counts: { selected: selected.length, available, unavailable: selected.length - available,
        warningRows: selected.filter(row => row.warnings.length > 0).length }, warnings,
      coverageProven: false, acquisitionState: "unknown", importState: "unknown",
    };
  } catch (error) {
    return { ok: false, error: error instanceof DistributionAbort ? error.detail : { code: "invalid_input" } };
  }
}
