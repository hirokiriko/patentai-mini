import { parseKohoCsv as parseLegacyKohoCsv } from "./parser";
import { countCodePoints } from "./scalar";
import type * as Legacy from "./types";
import type {
  KohoCsvAbstractSemantic,
  KohoCsvContents2Semantic,
  KohoCsvEncodingMetadata,
  KohoCsvIssue,
  KohoCsvIssueCode,
  KohoCsvLimits,
  KohoCsvLineEndingMetadata,
  KohoCsvLogicalFile,
  KohoCsvParseInput,
  KohoCsvParseResult,
  KohoCsvRecord,
  KohoCsvSourceMetadata,
  KohoCsvStatus,
} from "./contract-types";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

const EXPECTED_BASENAME: Readonly<Record<KohoCsvLogicalFile, string>> = {
  abstract: "ABSTRACT.csv",
  document_list: "DOCUMENT_LIST.csv",
  contents1: "CONTENTS1.csv",
  contents2: "CONTENTS2.csv",
};

const ISSUE_MESSAGES: Readonly<Record<KohoCsvIssueCode, string>> = {
  invalid_limits: "CSV limits are invalid",
  input_too_large: "CSV input exceeds the configured byte limit",
  invalid_utf8: "CSV input is not valid UTF-8",
  bom_unexpected: "CSV input contains an unexpected UTF-8 BOM",
  line_ending_unexpected: "CSV input contains an unexpected line ending",
  missing_terminal_newline: "CSV input does not end with a newline",
  unsafe_entry_path: "CSV entry path is unsafe",
  logical_file_mismatch: "CSV basename conflicts with the requested logical file",
  unexpected_file_location: "CSV entry is outside the expected logical location",
  csv_malformed: "CSV syntax is invalid",
  record_limit: "CSV record count exceeds the configured limit",
  column_limit: "CSV column count exceeds the configured limit",
  cell_length_limit: "CSV cell characters exceed the configured limit",
  total_character_limit: "CSV characters exceed the configured total limit",
  column_count_mismatch: "CSV record column count is invalid",
  required_value_missing: "CSV is missing a required value",
  invalid_decimal: "CSV decimal value is invalid",
  invalid_date: "CSV date is invalid",
  repeat_count_mismatch: "CSV repeated item count does not match its cells",
  character_length_mismatch: "CSV character length does not match its source value",
  record_length_mismatch: "CSV record length does not match the candidate calculation",
  unknown_package_code: "CSV package code requires review",
  unknown_section: "CSV section name requires review",
  unknown_country_code: "CSV country code requires review",
  unknown_kind_code: "CSV kind code requires review",
  unknown_display_flag: "CSV display flag requires review",
  duplicate_publication_number: "CSV contains a duplicate publication number",
  conflicting_duplicate: "CSV duplicate publication records conflict",
  display_slot_mismatch: "CSV display flag count does not match its slots",
  opaque_control_value: "CSV control value is preserved as opaque metadata",
  duplicate_section: "CSV contains a duplicate section",
  invalid_semicolon_list: "CSV semicolon list is invalid",
  empty_title: "CSV title is empty",
  empty_applicant_name: "CSV applicant name is empty",
  summary_missing: "CSV package summary records are absent",
};

const LEGACY_CODE_MAP: Readonly<
  Partial<Record<Legacy.KohoCsvIssueCode, KohoCsvIssueCode>>
> = {
  invalid_limits: "invalid_limits",
  unsafe_entry_path: "unsafe_entry_path",
  csv_byte_limit_exceeded: "input_too_large",
  invalid_utf8: "invalid_utf8",
  csv_syntax_error: "csv_malformed",
  empty_file: "required_value_missing",
  empty_record: "required_value_missing",
  required_record_missing: "required_value_missing",
  record_limit_exceeded: "record_limit",
  column_limit_exceeded: "column_limit",
  cell_character_limit_exceeded: "cell_length_limit",
  total_character_limit_exceeded: "total_character_limit",
  column_count_mismatch: "column_count_mismatch",
  required_field_empty: "required_value_missing",
  invalid_date: "invalid_date",
  invalid_decimal: "invalid_decimal",
  repeated_item_limit_exceeded: "repeat_count_mismatch",
  repeated_cell_count_mismatch: "repeat_count_mismatch",
  character_length_mismatch: "character_length_mismatch",
  package_code_mismatch: "unknown_package_code",
  unknown_section: "unknown_section",
  duplicate_section: "duplicate_section",
  invalid_semicolon_list: "invalid_semicolon_list",
  unknown_country_code: "unknown_country_code",
  unknown_kind: "unknown_kind_code",
  package_kind_mismatch: "unknown_kind_code",
  duplicate_publication_number: "duplicate_publication_number",
  publication_record_conflict: "conflicting_duplicate",
  empty_title: "empty_title",
  empty_applicant_name: "empty_applicant_name",
  unknown_display_flag: "unknown_display_flag",
  display_slot_mismatch: "display_slot_mismatch",
};

interface NormalizedPath {
  value: string;
  segments: string[];
}

function issue(
  code: KohoCsvIssueCode,
  status: Exclude<KohoCsvStatus, "success">,
  context: Pick<KohoCsvIssue, "recordNumber" | "columnPosition" | "field"> = {},
): KohoCsvIssue {
  return {
    code,
    status,
    message: ISSUE_MESSAGES[code],
    ...(context.recordNumber === undefined
      ? {}
      : { recordNumber: context.recordNumber }),
    ...(context.columnPosition === undefined
      ? {}
      : { columnPosition: context.columnPosition }),
    ...(context.field === undefined ? {} : { field: context.field }),
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function validateLimits(limits: KohoCsvLimits): KohoCsvIssue[] {
  if (limits === null || typeof limits !== "object") {
    return [issue("invalid_limits", "failed", { field: "limits" })];
  }
  const fields = [
    "maxInputBytes",
    "maxRecords",
    "maxColumnsPerRecord",
    "maxCellCharacters",
    "maxTotalCharacters",
  ] as const satisfies readonly (keyof KohoCsvLimits)[];
  return fields.flatMap((field) =>
    isPositiveSafeInteger(limits[field])
      ? []
      : [issue("invalid_limits", "failed", { field })],
  );
}

function normalizeEntryPath(source: string): NormalizedPath | null {
  if (source.length === 0 || source.includes("\0")) return null;
  if (
    source.startsWith("/") ||
    source.startsWith("\\") ||
    source.startsWith("//") ||
    source.startsWith("\\\\") ||
    /^[A-Za-z]:/.test(source) ||
    source.endsWith("/") ||
    source.endsWith("\\")
  ) {
    return null;
  }
  const value = source.replace(/\\/g, "/");
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return { value, segments };
}

function expectedLocation(
  packageType: KohoCsvParseInput["packageType"],
  logicalFile: KohoCsvLogicalFile,
  segments: readonly string[],
): boolean {
  if (logicalFile === "abstract" || logicalFile === "document_list") {
    return segments.length === 1;
  }
  if (segments.length !== 3 || segments[0] !== "DOCUMENT") return false;
  if (packageType === "JPB") return segments[1] === "P_B1";
  return segments[1] === "P_A1" || segments[1] === "P_P1";
}

function canonicalLegacyPath(
  input: KohoCsvParseInput,
  normalized: NormalizedPath,
): string {
  const basename = EXPECTED_BASENAME[input.logicalFile];
  if (input.logicalFile === "abstract" || input.logicalFile === "document_list") {
    return basename;
  }
  if (expectedLocation(input.packageType, input.logicalFile, normalized.segments)) {
    return normalized.value;
  }
  const section = input.packageType === "JPA" ? "P_A1" : "P_B1";
  return `DOCUMENT/${section}/${basename}`;
}

function byteLength(input: KohoCsvParseInput): number {
  return input.csv instanceof Uint8Array
    ? input.csv.byteLength
    : new TextEncoder().encode(input.csv).byteLength;
}

function uninspectedSource(input: KohoCsvParseInput): KohoCsvSourceMetadata {
  return {
    encoding: {
      name: "utf-8",
      inputType: input.csv instanceof Uint8Array ? "uint8array" : "string",
      byteLength: byteLength(input),
      strictUtf8: true,
      bom: "not_inspected",
    },
    delimiter: ",",
    lineEndings: null,
  };
}

function inspectLineEndings(text: string): KohoCsvLineEndingMetadata {
  let crlfCount = 0;
  let lfCount = 0;
  let crCount = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") {
        crlfCount += 1;
        index += 1;
      } else {
        crCount += 1;
      }
    } else if (text[index] === "\n") {
      lfCount += 1;
    }
  }
  const styles = Number(crlfCount > 0) + Number(lfCount > 0) + Number(crCount > 0);
  const style: KohoCsvLineEndingMetadata["style"] =
    styles === 0
      ? "none"
      : styles > 1
        ? "mixed"
        : crlfCount > 0
          ? "crlf"
          : lfCount > 0
            ? "lf"
            : "cr";
  return {
    style,
    crlfCount,
    lfCount,
    crCount,
    hasTerminalNewline: /(?:\r\n|\r|\n)$/.test(text),
    hasTerminalCrlf: text.endsWith("\r\n"),
  };
}

function decodeInput(input: KohoCsvParseInput):
  | {
      ok: true;
      bytes: Uint8Array;
      text: string;
      source: KohoCsvSourceMetadata;
      issues: KohoCsvIssue[];
    }
  | {
      ok: false;
      source: KohoCsvSourceMetadata;
      issues: KohoCsvIssue[];
    } {
  const bytes =
    input.csv instanceof Uint8Array
      ? input.csv
      : new TextEncoder().encode(input.csv);
  const byteBom =
    bytes.byteLength >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2];
  const stringBom =
    typeof input.csv === "string" && input.csv.charCodeAt(0) === 0xfeff;
  const hasBom = byteBom || stringBom;

  let decoded: string;
  if (input.csv instanceof Uint8Array) {
    const payload = byteBom ? bytes.subarray(3) : bytes;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        payload,
      );
    } catch {
      return {
        ok: false,
        source: {
          encoding: {
            name: "utf-8",
            inputType: "uint8array",
            byteLength: bytes.byteLength,
            strictUtf8: true,
            bom: hasBom ? "present" : "absent",
          },
          delimiter: ",",
          lineEndings: null,
        },
        issues: [issue("invalid_utf8", "failed")],
      };
    }
  } else {
    decoded = stringBom ? input.csv.slice(1) : input.csv;
  }

  const lineEndings = inspectLineEndings(decoded);
  const issues: KohoCsvIssue[] = [];
  if (hasBom) issues.push(issue("bom_unexpected", "review_required"));
  if (
    lineEndings.style === "lf" ||
    lineEndings.style === "cr" ||
    lineEndings.style === "mixed"
  ) {
    issues.push(issue("line_ending_unexpected", "review_required"));
  }
  if (decoded.length > 0 && !lineEndings.hasTerminalNewline) {
    issues.push(issue("missing_terminal_newline", "review_required"));
  }

  return {
    ok: true,
    bytes,
    text: decoded,
    source: {
      encoding: {
        name: "utf-8",
        inputType: input.csv instanceof Uint8Array ? "uint8array" : "string",
        byteLength: bytes.byteLength,
        strictUtf8: true,
        bom: hasBom ? "present" : "absent",
      },
      delimiter: ",",
      lineEndings,
    },
    issues,
  };
}

function failureResult(
  input: KohoCsvParseInput,
  normalizedEntryPath: string | null,
  source: KohoCsvSourceMetadata,
  issues: KohoCsvIssue[],
): KohoCsvParseResult {
  return {
    status: "failed",
    packageType: input.packageType,
    logicalFile: input.logicalFile,
    sourceEntryPath: input.entryPath,
    normalizedEntryPath,
    source,
    issues,
    recordCount: 0,
    records: [],
  } as KohoCsvParseResult;
}

function mapLegacyIssue(
  legacyIssue: Legacy.KohoCsvIssue,
  input: KohoCsvParseInput,
): KohoCsvIssue | null {
  if (
    legacyIssue.code === "utf8_bom_present" ||
    legacyIssue.code === "unobserved_line_ending" ||
    legacyIssue.code === "missing_terminal_crlf" ||
    legacyIssue.code === "jpb_record_length_unverified" ||
    legacyIssue.code === "unsupported_logical_file" ||
    legacyIssue.code === "unsupported_entry_placement"
  ) {
    return null;
  }

  let code = LEGACY_CODE_MAP[legacyIssue.code];
  if (legacyIssue.code === "character_length_mismatch") {
    code =
      legacyIssue.field === "recordCharacterLength" ||
      legacyIssue.field === "recordLength"
        ? "record_length_mismatch"
        : "character_length_mismatch";
  }
  if (
    legacyIssue.code === "required_record_missing" &&
    input.logicalFile === "abstract" &&
    legacyIssue.field === "summary"
  ) {
    code = "summary_missing";
  }
  if (code === undefined) return null;

  const status: Exclude<KohoCsvStatus, "success"> =
    code === "unknown_package_code" ||
    code === "unknown_kind_code" ||
    code === "unknown_section" ||
    code === "unknown_country_code" ||
    code === "unknown_display_flag" ||
    code === "duplicate_publication_number" ||
    code === "conflicting_duplicate" ||
    code === "duplicate_section" ||
    code === "empty_title" ||
    code === "empty_applicant_name" ||
    code === "summary_missing"
      ? "review_required"
      : "failed";

  return issue(code, status, {
    ...(legacyIssue.recordOrdinal === undefined
      ? {}
      : { recordNumber: legacyIssue.recordOrdinal }),
    ...(legacyIssue.field === undefined ? {} : { field: legacyIssue.field }),
  });
}

function recordStatus(issues: readonly KohoCsvIssue[]): KohoCsvStatus {
  if (issues.some((item) => item.status === "failed")) return "failed";
  if (issues.some((item) => item.status === "review_required")) {
    return "review_required";
  }
  return "success";
}

function rehydrateReviewSemantic(
  input: KohoCsvParseInput,
  record: Legacy.KohoCsvRecord<unknown>,
): unknown {
  const cells = record.sourceCells;
  if (input.logicalFile === "abstract" && record.ordinal === 1 && cells.length === 4) {
    return {
      recordType: "metadata",
      packageCode: cells[0],
      publicationDate: cells[1],
      issueNumber: cells[2],
      issueControlValue: cells[3],
    } satisfies KohoCsvAbstractSemantic;
  }
  if (input.logicalFile === "document_list" && cells.length === 4) {
    const knownKinds = new Set(["A", "A5", "B1", "B2"]);
    return {
      countryCode: {
        sourceValue: cells[0],
        knownValue: cells[0] === "JP" ? "JP" : null,
      },
      publicationNumber: cells[1],
      kindCode: {
        sourceValue: cells[2],
        knownValue: knownKinds.has(cells[2])
          ? (cells[2] as Legacy.KohoCsvKnownKind)
          : null,
      },
      issuePublicationDate: cells[3],
    } satisfies Legacy.KohoCsvDocumentListProjection;
  }
  return null;
}

function addContents2SemanticSlots(
  semantic: Legacy.KohoCsvContents2Projection,
): KohoCsvContents2Semantic {
  const sourceSlots = [
    semantic.displaySlot1,
    semantic.displaySlot2,
    semantic.displaySlot3,
    semantic.displaySlot4,
    semantic.displaySlot5,
    semantic.displaySlot6,
    semantic.displaySlot7,
  ];
  return {
    ...semantic,
    semanticDisplaySlots: sourceSlots.map((value, index) =>
      index < semantic.displayFlagCount.value ? value : null,
    ),
  };
}

function mapLegacyRecord(
  input: KohoCsvParseInput,
  legacyRecord: Legacy.KohoCsvRecord<unknown>,
): KohoCsvRecord<unknown> {
  const issues = legacyRecord.issues
    .map((item) => mapLegacyIssue(item, input))
    .filter((item): item is KohoCsvIssue => item !== null);

  if (input.logicalFile === "contents2" && input.packageType === "JPB") {
    const declared = legacyRecord.sourceCells[0];
    if (/^[0-9]+$/.test(declared ?? "")) {
      const numeric = Number(declared);
      const candidate = countCodePoints(legacyRecord.rawRecord) + 1;
      if (Number.isSafeInteger(numeric) && numeric !== candidate) {
        issues.push(
          issue("record_length_mismatch", "review_required", {
            recordNumber: legacyRecord.ordinal,
            field: "recordLength",
          }),
        );
      }
    }
  }

  const status = recordStatus(issues);
  let semantic = legacyRecord.projection;
  if (semantic === null && status !== "failed") {
    semantic = rehydrateReviewSemantic(input, legacyRecord);
  }
  if (
    input.logicalFile === "contents2" &&
    semantic !== null &&
    typeof semantic === "object" &&
    "displayFlagCount" in semantic
  ) {
    semantic = addContents2SemanticSlots(
      semantic as Legacy.KohoCsvContents2Projection,
    );
  }

  return {
    recordNumber: legacyRecord.ordinal,
    startLine: legacyRecord.startLine,
    endLine: legacyRecord.endLine,
    rawRecord: legacyRecord.rawRecord,
    sourceCells: [...legacyRecord.sourceCells],
    semantic: status === "failed" ? null : semantic,
    status,
    issues,
  };
}

function rollupStatus(
  fileIssues: readonly KohoCsvIssue[],
  records: readonly KohoCsvRecord<unknown>[],
): KohoCsvStatus {
  if (
    fileIssues.some((item) => item.status === "failed") ||
    records.some((record) => record.status === "failed")
  ) {
    return "failed";
  }
  if (
    fileIssues.some((item) => item.status === "review_required") ||
    records.some((record) => record.status === "review_required")
  ) {
    return "review_required";
  }
  return "success";
}

function parseContractKohoCsv(input: KohoCsvParseInput): KohoCsvParseResult {
  const limitIssues = validateLimits(input.limits);
  if (limitIssues.length > 0) {
    return failureResult(input, null, uninspectedSource(input), limitIssues);
  }

  const normalized = normalizeEntryPath(input.entryPath);
  if (normalized === null) {
    return failureResult(
      input,
      null,
      uninspectedSource(input),
      [issue("unsafe_entry_path", "failed")],
    );
  }

  const expectedBasename = EXPECTED_BASENAME[input.logicalFile];
  if (normalized.segments.at(-1) !== expectedBasename) {
    return failureResult(
      input,
      normalized.value,
      uninspectedSource(input),
      [issue("logical_file_mismatch", "failed")],
    );
  }

  const placementIssues = expectedLocation(
    input.packageType,
    input.logicalFile,
    normalized.segments,
  )
    ? []
    : [issue("unexpected_file_location", "review_required")];

  if (byteLength(input) > input.limits.maxInputBytes) {
    return failureResult(
      input,
      normalized.value,
      uninspectedSource(input),
      [...placementIssues, issue("input_too_large", "failed")],
    );
  }

  const decoded = decodeInput(input);
  if (!decoded.ok) {
    return failureResult(input, normalized.value, decoded.source, [
      ...placementIssues,
      ...decoded.issues,
    ]);
  }

  if (countCodePoints(decoded.text) > input.limits.maxTotalCharacters) {
    return failureResult(input, normalized.value, decoded.source, [
      ...placementIssues,
      ...decoded.issues,
      issue("total_character_limit", "failed"),
    ]);
  }

  const legacyInput: Legacy.KohoCsvParseInput = {
    packageType: input.packageType,
    entryPath: canonicalLegacyPath(input, normalized),
    bytes: decoded.bytes,
    limits: {
      maxCsvBytes: input.limits.maxInputBytes,
      maxRecords: input.limits.maxRecords,
      maxColumnsPerRecord: input.limits.maxColumnsPerRecord,
      maxCellCharacters: input.limits.maxCellCharacters,
      maxTotalCharacters: input.limits.maxTotalCharacters,
      // A repeat cannot validly consume more items than the record column cap.
      maxRepeatedItemsPerRecord: input.limits.maxColumnsPerRecord,
    },
  };
  const legacyResult = parseLegacyKohoCsv(legacyInput);
  const mappedFileIssues = legacyResult.issues
    .map((item) => mapLegacyIssue(item, input))
    .filter((item): item is KohoCsvIssue => item !== null);
  const fileIssues = [
    ...placementIssues,
    ...decoded.issues,
    ...mappedFileIssues,
  ];
  const legacyRecords = legacyResult.records as readonly Legacy.KohoCsvRecord<unknown>[];
  const records = legacyRecords.map((record) => mapLegacyRecord(input, record));

  return {
    status: rollupStatus(fileIssues, records),
    packageType: input.packageType,
    logicalFile: input.logicalFile,
    sourceEntryPath: input.entryPath,
    normalizedEntryPath: normalized.value,
    source: decoded.source,
    issues: fileIssues,
    recordCount: records.length,
    records,
  } as KohoCsvParseResult;
}

function isContractInput(
  input: KohoCsvParseInput | Legacy.KohoCsvParseInput,
): input is KohoCsvParseInput {
  return "csv" in input && "logicalFile" in input;
}

export function parseKohoCsv(input: KohoCsvParseInput): KohoCsvParseResult;
/** @deprecated Compatibility overload for the parser contract merged in PR #39. */
export function parseKohoCsv(
  input: Legacy.KohoCsvParseInput,
): Legacy.KohoCsvParseResult;
export function parseKohoCsv(
  input: KohoCsvParseInput | Legacy.KohoCsvParseInput,
): KohoCsvParseResult | Legacy.KohoCsvParseResult {
  return isContractInput(input)
    ? parseContractKohoCsv(input)
    : parseLegacyKohoCsv(input);
}
