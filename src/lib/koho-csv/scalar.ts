import { createIssue } from "./issues";
import type {
  KohoCsvDecimalValue,
  KohoCsvIssue,
  KohoCsvOptionalString,
} from "./types";

export interface ScalarIssueContext {
  recordOrdinal?: number;
  field: string;
}

export type ScalarValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issue: KohoCsvIssue };

export interface CharacterLengthValidation {
  actualLength: number;
  issue: KohoCsvIssue | null;
}

export function countCodePoints(value: string): number {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    count += 1;
  }
  return count;
}

export function validateRequiredField(
  sourceValue: string,
  context: ScalarIssueContext,
): ScalarValidationResult<string> {
  if (sourceValue.length === 0) {
    return {
      ok: false,
      issue: createIssue("required_field_empty", context),
    };
  }
  return { ok: true, value: sourceValue };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function parseCsvDate(
  sourceValue: string,
  context: ScalarIssueContext,
): ScalarValidationResult<string> {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(sourceValue);
  if (!match) {
    return { ok: false, issue: createIssue("invalid_date", context) };
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
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

  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1]
  ) {
    return { ok: false, issue: createIssue("invalid_date", context) };
  }

  return { ok: true, value: sourceValue };
}

export function parseCsvDecimal(
  sourceValue: string,
  context: ScalarIssueContext,
  options: { exactDigits?: number } = {},
): ScalarValidationResult<KohoCsvDecimalValue> {
  if (
    !/^\d+$/.test(sourceValue) ||
    (options.exactDigits !== undefined &&
      sourceValue.length !== options.exactDigits)
  ) {
    return { ok: false, issue: createIssue("invalid_decimal", context) };
  }

  const value = Number(sourceValue);
  if (!Number.isSafeInteger(value)) {
    return { ok: false, issue: createIssue("invalid_decimal", context) };
  }

  return {
    ok: true,
    value: { sourceValue, value },
  };
}

export function parseSemicolonList(
  sourceValue: string,
  context: ScalarIssueContext,
): ScalarValidationResult<{ sourceValue: string; values: string[] }> {
  if (sourceValue.length === 0) {
    return { ok: true, value: { sourceValue, values: [] } };
  }

  const values = sourceValue.split(";");
  if (values.some((value) => value.length === 0)) {
    return {
      ok: false,
      issue: createIssue("invalid_semicolon_list", context),
    };
  }

  return { ok: true, value: { sourceValue, values } };
}

export function validateCharacterLength(
  expectedLength: number,
  sourceValue: string,
  context: ScalarIssueContext,
): CharacterLengthValidation {
  const actualLength = countCodePoints(sourceValue);
  return {
    actualLength,
    issue:
      actualLength === expectedLength
        ? null
        : createIssue("character_length_mismatch", context),
  };
}

export function optionalString(sourceValue: string): KohoCsvOptionalString {
  return {
    sourceValue,
    value: sourceValue.length === 0 ? null : sourceValue,
  };
}

export function removeTrailingAsciiSpaces(sourceValue: string): string {
  return sourceValue.replace(/ +$/u, "");
}
