import { parseAbstractRecords } from "./parse-abstract";
import { parseContents1Records } from "./parse-contents1";
import { parseContents2Records } from "./parse-contents2";
import { parseDocumentListRecords } from "./parse-document-list";
import { parseCsvRecordsFromUtf8Bytes } from "./csv-records";
import { parseKohoCsv as parseLegacyKohoCsv } from "./parser";
import { countCodePoints } from "./scalar";
import type * as Legacy from "./types";
import type {
  KohoCsvContractAbstractSemantic,
  KohoCsvContractContents2Semantic,
  KohoCsvContractEncodingMetadata,
  KohoCsvContractIssue,
  KohoCsvContractIssueCode,
  KohoCsvContractLimits,
  KohoCsvContractLineEndingMetadata,
  KohoCsvContractLogicalFile,
  KohoCsvContractParseInput,
  KohoCsvContractParseResult,
  KohoCsvContractRecord,
  KohoCsvContractSourceMetadata,
  KohoCsvContractStatus,
} from "./contract-types";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

const EXPECTED_BASENAME: Readonly<
  Record<KohoCsvContractLogicalFile, string>
> = {
  abstract: "ABSTRACT.csv",
  document_list: "DOCUMENT_LIST.csv",
  contents1: "CONTENTS1.csv",
  contents2: "CONTENTS2.csv",
};

const ISSUE_MESSAGES: Readonly<Record<KohoCsvContractIssueCode, string>> = {
  invalid_limits: "CSV limits are invalid",
  input_too_large: "CSV input exceeds the configured byte limit",
  invalid_unicode_scalar: "CSV string contains an invalid Unicode scalar",
  invalid_utf8: "CSV input is not valid UTF-8",
  bom_unexpected: "CSV input contains an unexpected UTF-8 BOM",
  line_ending_unexpected: "CSV input contains an unexpected line ending",
  missing_terminal_newline: "CSV input does not end with a newline",
  unsafe_entry_path: "CSV entry path is unsafe",
  logical_file_mismatch:
    "CSV basename conflicts with the requested logical file",
  unexpected_file_location:
    "CSV entry is outside the expected logical location",
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
  character_length_mismatch:
    "CSV character length does not match its source value",
  record_length_mismatch:
    "CSV record length does not match the candidate calculation",
  unknown_package_code: "CSV package code requires review",
  unknown_section: "CSV section name requires review",
  unknown_country_code: "CSV country code requires review",
  unknown_kind_code: "CSV kind code requires review",
  unknown_display_flag: "CSV display flag requires review",
  duplicate_publication_number:
    "CSV contains a duplicate publication number",
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
  Partial<Record<Legacy.KohoCsvIssueCode, KohoCsvContractIssueCode>>
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

type ObservedInputType = Exclude<
  KohoCsvContractEncodingMetadata["inputType"],
  "not_inspected"
>;

type InputPreflightResult =
  | {
      ok: true;
      inputType: ObservedInputType;
      byteLength: number;
      bytes: Uint8Array;
    }
  | {
      ok: false;
      inputType: KohoCsvContractEncodingMetadata["inputType"];
      byteLength: number | null;
      code:
        | "input_too_large"
        | "invalid_unicode_scalar"
        | "invalid_utf8";
    };

interface LegacySemanticOutput {
  issues: Legacy.KohoCsvIssue[];
  records: Legacy.KohoCsvRecord<unknown>[];
}

function issue(
  code: KohoCsvContractIssueCode,
  status: Exclude<KohoCsvContractStatus, "success">,
  context: Pick<
    KohoCsvContractIssue,
    "recordNumber" | "columnPosition" | "field"
  > = {},
): KohoCsvContractIssue {
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

function validateLimits(
  limits: KohoCsvContractLimits,
): KohoCsvContractIssue[] {
  if (limits === null || typeof limits !== "object") {
    return [issue("invalid_limits", "failed", { field: "limits" })];
  }
  const fields = [
    "maxInputBytes",
    "maxRecords",
    "maxColumnsPerRecord",
    "maxCellCharacters",
    "maxTotalCharacters",
  ] as const satisfies readonly (keyof KohoCsvContractLimits)[];
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
  packageType: KohoCsvContractParseInput["packageType"],
  logicalFile: KohoCsvContractLogicalFile,
  segments: readonly string[],
): boolean {
  if (logicalFile === "abstract" || logicalFile === "document_list") {
    return segments.length === 1;
  }
  if (segments.length !== 3 || segments[0] !== "DOCUMENT") return false;
  if (packageType === "JPB") return segments[1] === "P_B1";
  return segments[1] === "P_A1" || segments[1] === "P_P1";
}

function sourceMetadata(
  encoding: KohoCsvContractEncodingMetadata,
  lineEndings: KohoCsvContractLineEndingMetadata | null = null,
): KohoCsvContractSourceMetadata {
  return { encoding, delimiter: ",", lineEndings };
}

function uninspectedSource(): KohoCsvContractSourceMetadata {
  return sourceMetadata({
    name: "utf-8",
    inputType: "not_inspected",
    byteLength: null,
    strictUtf8: true,
    bom: "not_inspected",
  });
}

function preflightFailureSource(
  inputType: KohoCsvContractEncodingMetadata["inputType"],
  byteLength: number | null,
): KohoCsvContractSourceMetadata {
  return sourceMetadata({
    name: "utf-8",
    inputType,
    byteLength,
    strictUtf8: true,
    bom: "not_inspected",
  });
}

function observedEncoding(
  inputType: ObservedInputType,
  byteLength: number,
  bom: "present" | "absent",
): KohoCsvContractEncodingMetadata {
  return {
    name: "utf-8",
    inputType,
    byteLength,
    strictUtf8: true,
    bom,
  };
}

function inspectStringUtf8ByteLength(
  value: string,
  maxInputBytes: number,
):
  | { ok: true; byteLength: number }
  | {
      ok: false;
      code: "input_too_large" | "invalid_unicode_scalar";
    } {
  let usedBytes = 0;
  let index = 0;
  while (index < value.length) {
    const codeUnit = value.charCodeAt(index);
    let addition: number;
    let width = 1;

    if (codeUnit <= 0x7f) {
      addition = 1;
    } else if (codeUnit <= 0x7ff) {
      addition = 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { ok: false, code: "invalid_unicode_scalar" };
      }
      addition = 4;
      width = 2;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return { ok: false, code: "invalid_unicode_scalar" };
    } else {
      addition = 3;
    }

    if (addition > maxInputBytes - usedBytes) {
      return { ok: false, code: "input_too_large" };
    }
    usedBytes += addition;
    index += width;
  }
  return { ok: true, byteLength: usedBytes };
}

function preflightInput(
  csv: string | Uint8Array,
  maxInputBytes: number,
): InputPreflightResult {
  if (csv instanceof Uint8Array) {
    if (csv.byteLength > maxInputBytes) {
      return {
        ok: false,
        inputType: "uint8array",
        byteLength: csv.byteLength,
        code: "input_too_large",
      };
    }
    return {
      ok: true,
      inputType: "uint8array",
      byteLength: csv.byteLength,
      bytes: csv,
    };
  }

  if (typeof csv !== "string") {
    return {
      ok: false,
      inputType: "not_inspected",
      byteLength: null,
      code: "invalid_utf8",
    };
  }

  const inspected = inspectStringUtf8ByteLength(csv, maxInputBytes);
  if (!inspected.ok) {
    return {
      ok: false,
      inputType: "string",
      byteLength: null,
      code: inspected.code,
    };
  }

  const bytes = new TextEncoder().encode(csv);
  return {
    ok: true,
    inputType: "string",
    byteLength: inspected.byteLength,
    bytes,
  };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}

function exceedsCodePointLimit(value: string, limit: number): boolean {
  let count = 0;
  const iterator = value[Symbol.iterator]();
  while (!iterator.next().done) {
    if (count === limit) return true;
    count += 1;
  }
  return false;
}

function inspectLineEndings(
  text: string,
): KohoCsvContractLineEndingMetadata {
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
  const styles =
    Number(crlfCount > 0) + Number(lfCount > 0) + Number(crCount > 0);
  const style: KohoCsvContractLineEndingMetadata["style"] =
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

function failureResult(
  input: KohoCsvContractParseInput,
  normalizedEntryPath: string | null,
  source: KohoCsvContractSourceMetadata,
  issues: KohoCsvContractIssue[],
): KohoCsvContractParseResult {
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
  } as KohoCsvContractParseResult;
}

function mapLegacyIssue(
  legacyIssue: Legacy.KohoCsvIssue,
  input: KohoCsvContractParseInput,
): KohoCsvContractIssue | null {
  if (
    input.logicalFile === "abstract" &&
    legacyIssue.code === "required_field_empty" &&
    legacyIssue.field === "issueControlValue"
  ) {
    // Issue #40 defines this source field as opaque, including the empty string.
    return null;
  }
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

  const status: Exclude<KohoCsvContractStatus, "success"> =
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

function recordStatus(
  issues: readonly KohoCsvContractIssue[],
): KohoCsvContractStatus {
  if (issues.some((item) => item.status === "failed")) return "failed";
  if (issues.some((item) => item.status === "review_required")) {
    return "review_required";
  }
  return "success";
}

function rehydrateReviewSemantic(
  input: KohoCsvContractParseInput,
  record: Legacy.KohoCsvRecord<unknown>,
): unknown {
  const cells = record.sourceCells;
  if (
    input.logicalFile === "abstract" &&
    record.ordinal === 1 &&
    cells.length === 4
  ) {
    return {
      recordType: "metadata",
      packageCode: cells[0],
      publicationDate: cells[1],
      issueNumber: cells[2],
      issueControlValue: cells[3],
    } satisfies KohoCsvContractAbstractSemantic;
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
): KohoCsvContractContents2Semantic {
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
  input: KohoCsvContractParseInput,
  legacyRecord: Legacy.KohoCsvRecord<unknown>,
): KohoCsvContractRecord<unknown> {
  const issues = legacyRecord.issues
    .map((item) => mapLegacyIssue(item, input))
    .filter((item): item is KohoCsvContractIssue => item !== null);

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
  fileIssues: readonly KohoCsvContractIssue[],
  records: readonly KohoCsvContractRecord<unknown>[],
): KohoCsvContractStatus {
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

function legacyLimits(
  limits: KohoCsvContractLimits,
): Legacy.KohoCsvLimits {
  return {
    maxCsvBytes: limits.maxInputBytes,
    maxRecords: limits.maxRecords,
    maxColumnsPerRecord: limits.maxColumnsPerRecord,
    maxCellCharacters: limits.maxCellCharacters,
    maxTotalCharacters: limits.maxTotalCharacters,
    maxRepeatedItemsPerRecord: limits.maxColumnsPerRecord,
  };
}

function parseSemanticRecords(
  input: KohoCsvContractParseInput,
  records: Legacy.ParsedCsvRecord[],
  limits: Legacy.KohoCsvLimits,
): LegacySemanticOutput {
  switch (input.logicalFile) {
    case "abstract": {
      const parsed = parseAbstractRecords({
        packageType: input.packageType,
        records,
      });
      return {
        issues: parsed.issues,
        records: parsed.records as Legacy.KohoCsvRecord<unknown>[],
      };
    }
    case "document_list": {
      const parsed = parseDocumentListRecords({
        packageType: input.packageType,
        records,
      });
      return {
        issues: parsed.issues,
        records: parsed.records as Legacy.KohoCsvRecord<unknown>[],
      };
    }
    case "contents1": {
      const parsed = parseContents1Records({
        packageType: input.packageType,
        records,
        limits,
      });
      return {
        issues: parsed.issues,
        records: parsed.records as Legacy.KohoCsvRecord<unknown>[],
      };
    }
    case "contents2": {
      const parsed = parseContents2Records({
        packageType: input.packageType,
        records,
        limits,
      });
      return {
        issues: parsed.issues,
        records: parsed.records as Legacy.KohoCsvRecord<unknown>[],
      };
    }
  }
}

function parseContractKohoCsv(
  input: KohoCsvContractParseInput,
): KohoCsvContractParseResult {
  const limitIssues = validateLimits(input.limits);
  if (limitIssues.length > 0) {
    return failureResult(input, null, uninspectedSource(), limitIssues);
  }

  const normalized = normalizeEntryPath(input.entryPath);
  if (normalized === null) {
    return failureResult(input, null, uninspectedSource(), [
      issue("unsafe_entry_path", "failed"),
    ]);
  }

  const expectedBasename = EXPECTED_BASENAME[input.logicalFile];
  if (normalized.segments.at(-1) !== expectedBasename) {
    return failureResult(input, normalized.value, uninspectedSource(), [
      issue("logical_file_mismatch", "failed"),
    ]);
  }

  const placementIssues = expectedLocation(
    input.packageType,
    input.logicalFile,
    normalized.segments,
  )
    ? []
    : [issue("unexpected_file_location", "review_required")];

  const preflight = preflightInput(input.csv, input.limits.maxInputBytes);
  if (!preflight.ok) {
    return failureResult(
      input,
      normalized.value,
      preflightFailureSource(preflight.inputType, preflight.byteLength),
      [...placementIssues, issue(preflight.code, "failed")],
    );
  }

  const hasBom = hasUtf8Bom(preflight.bytes);
  const encoding = observedEncoding(
    preflight.inputType,
    preflight.byteLength,
    hasBom ? "present" : "absent",
  );
  const bomIssues = hasBom
    ? [issue("bom_unexpected", "review_required")]
    : [];
  const payloadBytes = hasBom
    ? preflight.bytes.subarray(UTF8_BOM.length)
    : preflight.bytes;

  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      // The one inspected prefix is removed above. Preserve later U+FEFF.
      ignoreBOM: true,
    }).decode(payloadBytes);
  } catch {
    return failureResult(
      input,
      normalized.value,
      sourceMetadata(encoding),
      [
        ...placementIssues,
        ...bomIssues,
        issue("invalid_utf8", "failed"),
      ],
    );
  }

  if (exceedsCodePointLimit(text, input.limits.maxTotalCharacters)) {
    return failureResult(
      input,
      normalized.value,
      sourceMetadata(encoding),
      [
        ...placementIssues,
        ...bomIssues,
        issue("total_character_limit", "failed"),
      ],
    );
  }

  const lineEndings = inspectLineEndings(text);
  const lineEndingIssues: KohoCsvContractIssue[] = [];
  if (
    lineEndings.style === "lf" ||
    lineEndings.style === "cr" ||
    lineEndings.style === "mixed"
  ) {
    lineEndingIssues.push(
      issue("line_ending_unexpected", "review_required"),
    );
  }
  if (text.length > 0 && !lineEndings.hasTerminalNewline) {
    lineEndingIssues.push(
      issue("missing_terminal_newline", "review_required"),
    );
  }
  const source = sourceMetadata(encoding, lineEndings);
  const baseIssues = [
    ...placementIssues,
    ...bomIssues,
    ...lineEndingIssues,
  ];

  const limits = legacyLimits(input.limits);
  const parsedCsv = parseCsvRecordsFromUtf8Bytes(payloadBytes, limits);
  if (!parsedCsv.ok) {
    const parsedIssues = parsedCsv.issues
      .map((item) => mapLegacyIssue(item, input))
      .filter((item): item is KohoCsvContractIssue => item !== null);
    return failureResult(input, normalized.value, source, [
      ...baseIssues,
      ...parsedIssues,
    ]);
  }

  const semanticResult = parseSemanticRecords(input, parsedCsv.records, limits);
  const mappedFileIssues = semanticResult.issues
    .map((item) => mapLegacyIssue(item, input))
    .filter((item): item is KohoCsvContractIssue => item !== null);
  const fileIssues = [...baseIssues, ...mappedFileIssues];
  const records = semanticResult.records.map((record) =>
    mapLegacyRecord(input, record),
  );

  return {
    status: rollupStatus(fileIssues, records),
    packageType: input.packageType,
    logicalFile: input.logicalFile,
    sourceEntryPath: input.entryPath,
    normalizedEntryPath: normalized.value,
    source,
    issues: fileIssues,
    recordCount: records.length,
    records,
  } as KohoCsvContractParseResult;
}

function isLegacyInput(
  input: KohoCsvContractParseInput | Legacy.KohoCsvParseInput,
): input is Legacy.KohoCsvParseInput {
  return "bytes" in input;
}

export function parseKohoCsv(
  input: KohoCsvContractParseInput,
): KohoCsvContractParseResult;

// Keep the legacy overload last so Parameters/ReturnType remain PR #39 types.
export function parseKohoCsv(
  input: Legacy.KohoCsvParseInput,
): Legacy.KohoCsvParseResult;

export function parseKohoCsv(
  input: KohoCsvContractParseInput | Legacy.KohoCsvParseInput,
): KohoCsvContractParseResult | Legacy.KohoCsvParseResult {
  return isLegacyInput(input)
    ? parseLegacyKohoCsv(input)
    : parseContractKohoCsv(input);
}
