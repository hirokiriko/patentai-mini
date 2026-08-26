import type {
  KohoCsvAbstractProjection as LegacyAbstractProjection,
  KohoCsvContents1Projection as LegacyContents1Projection,
  KohoCsvContents2Projection as LegacyContents2Projection,
  KohoCsvDocumentListProjection as LegacyDocumentListProjection,
  KohoCsvPackageType,
} from "./types";

export type KohoCsvContractPackageType = KohoCsvPackageType;

export type KohoCsvContractLogicalFile =
  | "abstract"
  | "document_list"
  | "contents1"
  | "contents2";

export type KohoCsvContractStatus =
  | "success"
  | "review_required"
  | "failed";

export interface KohoCsvContractLimits {
  maxInputBytes: number;
  maxRecords: number;
  maxColumnsPerRecord: number;
  maxCellCharacters: number;
  maxTotalCharacters: number;
}

export interface KohoCsvContractParseInput {
  packageType: KohoCsvContractPackageType;
  logicalFile: KohoCsvContractLogicalFile;
  entryPath: string;
  csv: string | Uint8Array;
  limits: KohoCsvContractLimits;
}

export type KohoCsvContractIssueCode =
  | "invalid_limits"
  | "input_too_large"
  | "invalid_unicode_scalar"
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

export interface KohoCsvContractIssue {
  code: KohoCsvContractIssueCode;
  status: Exclude<KohoCsvContractStatus, "success">;
  message: string;
  recordNumber?: number;
  columnPosition?: number;
  field?: string;
}

export interface KohoCsvContractEncodingMetadata {
  name: "utf-8";
  inputType: "string" | "uint8array" | "not_inspected";
  byteLength: number | null;
  strictUtf8: true;
  bom: "present" | "absent" | "not_inspected";
}

export interface KohoCsvContractLineEndingMetadata {
  style: "crlf" | "lf" | "cr" | "mixed" | "none";
  crlfCount: number;
  lfCount: number;
  crCount: number;
  hasTerminalNewline: boolean;
  hasTerminalCrlf: boolean;
}

export interface KohoCsvContractSourceMetadata {
  encoding: KohoCsvContractEncodingMetadata;
  delimiter: ",";
  lineEndings: KohoCsvContractLineEndingMetadata | null;
}

export type KohoCsvContractAbstractSemantic = LegacyAbstractProjection;
export type KohoCsvContractDocumentListSemantic =
  LegacyDocumentListProjection;
export type KohoCsvContractContents1Semantic = LegacyContents1Projection;
export type KohoCsvContractContents2Semantic = LegacyContents2Projection & {
  semanticDisplaySlots: readonly (string | null)[];
};

export interface KohoCsvContractRecord<TSemantic> {
  recordNumber: number;
  startLine: number;
  endLine: number;
  rawRecord: string;
  sourceCells: string[];
  semantic: TSemantic | null;
  status: KohoCsvContractStatus;
  issues: KohoCsvContractIssue[];
}

export interface KohoCsvContractResultBase<
  TLogicalFile extends KohoCsvContractLogicalFile,
  TSemantic,
> {
  status: KohoCsvContractStatus;
  packageType: KohoCsvContractPackageType;
  logicalFile: TLogicalFile;
  sourceEntryPath: string;
  normalizedEntryPath: string | null;
  source: KohoCsvContractSourceMetadata;
  issues: KohoCsvContractIssue[];
  recordCount: number;
  records: KohoCsvContractRecord<TSemantic>[];
}

export type KohoCsvContractAbstractRecord =
  KohoCsvContractRecord<KohoCsvContractAbstractSemantic>;
export type KohoCsvContractDocumentListRecord =
  KohoCsvContractRecord<KohoCsvContractDocumentListSemantic>;
export type KohoCsvContractContents1Record =
  KohoCsvContractRecord<KohoCsvContractContents1Semantic>;
export type KohoCsvContractContents2Record =
  KohoCsvContractRecord<KohoCsvContractContents2Semantic>;

export type KohoCsvContractAbstractResult = KohoCsvContractResultBase<
  "abstract",
  KohoCsvContractAbstractSemantic
>;
export type KohoCsvContractDocumentListResult = KohoCsvContractResultBase<
  "document_list",
  KohoCsvContractDocumentListSemantic
>;
export type KohoCsvContractContents1Result = KohoCsvContractResultBase<
  "contents1",
  KohoCsvContractContents1Semantic
>;
export type KohoCsvContractContents2Result = KohoCsvContractResultBase<
  "contents2",
  KohoCsvContractContents2Semantic
>;

export type KohoCsvContractParseResult =
  | KohoCsvContractAbstractResult
  | KohoCsvContractDocumentListResult
  | KohoCsvContractContents1Result
  | KohoCsvContractContents2Result;
