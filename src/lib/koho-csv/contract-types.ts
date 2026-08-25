import type {
  KohoCsvAbstractProjection as LegacyAbstractProjection,
  KohoCsvContents1Projection as LegacyContents1Projection,
  KohoCsvContents2Projection as LegacyContents2Projection,
  KohoCsvDocumentListProjection as LegacyDocumentListProjection,
} from "./types";

export type KohoCsvPackageType = "JPA" | "JPB";

export type KohoCsvLogicalFile =
  | "abstract"
  | "document_list"
  | "contents1"
  | "contents2";

export type KohoCsvStatus = "success" | "review_required" | "failed";

export interface KohoCsvLimits {
  maxInputBytes: number;
  maxRecords: number;
  maxColumnsPerRecord: number;
  maxCellCharacters: number;
  maxTotalCharacters: number;
}

export interface KohoCsvParseInput {
  packageType: KohoCsvPackageType;
  logicalFile: KohoCsvLogicalFile;
  entryPath: string;
  csv: string | Uint8Array;
  limits: KohoCsvLimits;
}

export type KohoCsvIssueCode =
  | "invalid_limits"
  | "input_too_large"
  | "invalid_utf8"
  | "bom_unexpected"
  | "line_ending_unexpected"
  | "missing_terminal_newline"
  | "unsafe_entry_path"
  | "logical_file_mismatch"
  | "unexpected_file_location"
  | "csv_malformed"
  | "record_limit"
  | "column_limit"
  | "cell_length_limit"
  | "total_character_limit"
  | "column_count_mismatch"
  | "required_value_missing"
  | "invalid_decimal"
  | "invalid_date"
  | "repeat_count_mismatch"
  | "character_length_mismatch"
  | "record_length_mismatch"
  | "unknown_package_code"
  | "unknown_section"
  | "unknown_country_code"
  | "unknown_kind_code"
  | "unknown_display_flag"
  | "duplicate_publication_number"
  | "conflicting_duplicate"
  | "display_slot_mismatch"
  | "opaque_control_value"
  | "duplicate_section"
  | "invalid_semicolon_list"
  | "empty_title"
  | "empty_applicant_name"
  | "summary_missing";

export interface KohoCsvIssue {
  code: KohoCsvIssueCode;
  status: Exclude<KohoCsvStatus, "success">;
  message: string;
  recordNumber?: number;
  columnPosition?: number;
  field?: string;
}

export interface KohoCsvEncodingMetadata {
  name: "utf-8";
  inputType: "string" | "uint8array";
  byteLength: number;
  strictUtf8: true;
  bom: "present" | "absent" | "not_inspected";
}

export interface KohoCsvLineEndingMetadata {
  style: "crlf" | "lf" | "cr" | "mixed" | "none";
  crlfCount: number;
  lfCount: number;
  crCount: number;
  hasTerminalNewline: boolean;
  hasTerminalCrlf: boolean;
}

export interface KohoCsvSourceMetadata {
  encoding: KohoCsvEncodingMetadata;
  delimiter: ",";
  lineEndings: KohoCsvLineEndingMetadata | null;
}

export type KohoCsvAbstractSemantic = LegacyAbstractProjection;
export type KohoCsvDocumentListSemantic = LegacyDocumentListProjection;
export type KohoCsvContents1Semantic = LegacyContents1Projection;
export type KohoCsvContents2Semantic = LegacyContents2Projection & {
  semanticDisplaySlots: readonly (string | null)[];
};

export interface KohoCsvRecord<TSemantic> {
  recordNumber: number;
  startLine: number;
  endLine: number;
  rawRecord: string;
  sourceCells: string[];
  semantic: TSemantic | null;
  status: KohoCsvStatus;
  issues: KohoCsvIssue[];
}

interface KohoCsvResultBase<TLogicalFile extends KohoCsvLogicalFile, TSemantic> {
  status: KohoCsvStatus;
  packageType: KohoCsvPackageType;
  logicalFile: TLogicalFile;
  sourceEntryPath: string;
  normalizedEntryPath: string | null;
  source: KohoCsvSourceMetadata;
  issues: KohoCsvIssue[];
  recordCount: number;
  records: KohoCsvRecord<TSemantic>[];
}

export type KohoCsvAbstractResult = KohoCsvResultBase<
  "abstract",
  KohoCsvAbstractSemantic
>;
export type KohoCsvDocumentListResult = KohoCsvResultBase<
  "document_list",
  KohoCsvDocumentListSemantic
>;
export type KohoCsvContents1Result = KohoCsvResultBase<
  "contents1",
  KohoCsvContents1Semantic
>;
export type KohoCsvContents2Result = KohoCsvResultBase<
  "contents2",
  KohoCsvContents2Semantic
>;

export type KohoCsvParseResult =
  | KohoCsvAbstractResult
  | KohoCsvDocumentListResult
  | KohoCsvContents1Result
  | KohoCsvContents2Result;
