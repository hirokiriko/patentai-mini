export type KohoCsvPackageType = "JPA" | "JPB";

export type KohoCsvLogicalFile =
  | "ABSTRACT"
  | "DOCUMENT_LIST"
  | "CONTENTS1"
  | "CONTENTS2";

export type KohoCsvStatus =
  | "success"
  | "review_required"
  | "unsupported_type"
  | "failed";

export interface KohoCsvLimits {
  maxCsvBytes: number;
  maxRecords: number;
  maxColumnsPerRecord: number;
  maxCellCharacters: number;
  maxTotalCharacters: number;
  maxRepeatedItemsPerRecord: number;
}

export interface KohoCsvParseInput {
  packageType: KohoCsvPackageType;
  entryPath: string;
  bytes: Uint8Array;
  limits: KohoCsvLimits;
}

export type KohoCsvIssueCode =
  | "invalid_limits"
  | "unsafe_entry_path"
  | "package_section_mismatch"
  | "csv_byte_limit_exceeded"
  | "unsupported_logical_file"
  | "unsupported_entry_placement"
  | "invalid_utf8"
  | "utf8_bom_present"
  | "unobserved_line_ending"
  | "missing_terminal_crlf"
  | "csv_syntax_error"
  | "empty_file"
  | "empty_record"
  | "required_record_missing"
  | "record_limit_exceeded"
  | "column_limit_exceeded"
  | "cell_character_limit_exceeded"
  | "total_character_limit_exceeded"
  | "column_count_mismatch"
  | "required_field_empty"
  | "invalid_date"
  | "invalid_decimal"
  | "repeated_item_limit_exceeded"
  | "repeated_cell_count_mismatch"
  | "character_length_mismatch"
  | "package_code_mismatch"
  | "unknown_section"
  | "duplicate_section"
  | "invalid_semicolon_list"
  | "unknown_country_code"
  | "unknown_kind"
  | "package_kind_mismatch"
  | "duplicate_publication_number"
  | "publication_record_conflict"
  | "empty_title"
  | "empty_applicant_name"
  | "unknown_display_flag"
  | "display_slot_mismatch"
  | "jpb_record_length_unverified";

export interface KohoCsvIssue {
  code: KohoCsvIssueCode;
  status: Exclude<KohoCsvStatus, "success">;
  message: string;
  recordOrdinal?: number;
  field?: string;
}

export interface KohoCsvEncodingMetadata {
  name: "utf-8";
  fatalDecode: true;
  bom: "none" | "utf8" | "not_inspected";
  byteLength: number;
}

export interface KohoCsvLineEndingMetadata {
  style: "crlf" | "lf" | "cr" | "mixed" | "none";
  crlfCount: number;
  lfCount: number;
  crCount: number;
  hasTerminalCrlf: boolean;
}

export interface KohoCsvDecimalValue {
  sourceValue: string;
  value: number;
}

export interface KohoCsvOptionalString {
  sourceValue: string;
  value: string | null;
}

export type KohoCsvSection = "P_A1" | "P_A5" | "P_P1" | "P_P5" | "P_B1";

export interface KohoCsvAbstractMetadataProjection {
  recordType: "metadata";
  packageCode: string;
  publicationDate: string;
  issueNumber: string;
  issueControlValue: string;
}

export interface KohoCsvAbstractSummaryProjection {
  recordType: "summary";
  sectionName: string;
  normalizedSectionName: string;
  section: KohoCsvSection | null;
  publicationNumberRange: string;
  documentCount: KohoCsvDecimalValue;
  missingNumbersInRange: {
    sourceValue: string;
    values: string[];
  } | null;
  includedNumbersOutsideRange: {
    sourceValue: string;
    values: string[];
  } | null;
}

export type KohoCsvAbstractProjection =
  | KohoCsvAbstractMetadataProjection
  | KohoCsvAbstractSummaryProjection;

export type KohoCsvKnownKind = "A" | "A5" | "B1" | "B2";

export interface KohoCsvDocumentListProjection {
  countryCode: {
    sourceValue: string;
    knownValue: "JP" | null;
  };
  publicationNumber: string;
  kindCode: {
    sourceValue: string;
    knownValue: KohoCsvKnownKind | null;
  };
  issuePublicationDate: string;
}

export interface KohoCsvContents1Applicant {
  locationCharacterLength: KohoCsvDecimalValue;
  location: string;
  partyIdentifier: KohoCsvOptionalString;
  applicantNameCharacterLength: KohoCsvDecimalValue;
  applicantName: string;
}

export interface KohoCsvContents1Projection {
  recordCharacterLength: KohoCsvDecimalValue;
  computedRecordCharacterLength: number;
  divisionSectionCode: string;
  formattedPublicationNumber: string;
  registrationDate: string | null;
  formattedApplicationNumber: string;
  displayFlagCount: KohoCsvDecimalValue;
  displayFlags: string[];
  displayClassificationCount: KohoCsvDecimalValue;
  displayClassifications: string[];
  titleCharacterLength: KohoCsvDecimalValue;
  title: string;
  applicantCount: KohoCsvDecimalValue;
  applicants: KohoCsvContents1Applicant[];
}

export interface KohoCsvContents2Projection {
  recordLength: KohoCsvDecimalValue;
  computedRecordLength: number;
  matchesCandidate: boolean;
  divisionSectionCode: string;
  publicationNumber: string;
  registrationDate: string | null;
  applicationNumber: string;
  displayFlagCount: KohoCsvDecimalValue;
  displaySlot1: string;
  displaySlot2: string;
  displaySlot3: string;
  displaySlot4: string;
  displaySlot5: string;
  displaySlot6: string;
  displaySlot7: string;
  displayFlags: string[];
  firstClassification: KohoCsvOptionalString;
  title: string;
  firstApplicantLocation: KohoCsvOptionalString;
  firstPartyIdentifier: KohoCsvOptionalString;
  firstApplicantName: KohoCsvOptionalString;
  projectionCompleteness: "lossy_first_values_only";
}

export interface KohoCsvRecord<TProjection> {
  ordinal: number;
  startLine: number;
  endLine: number;
  rawRecord: string;
  sourceCells: string[];
  projection: TProjection | null;
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  issues: KohoCsvIssue[];
}

export type KohoCsvAbstractRecord = KohoCsvRecord<KohoCsvAbstractProjection>;
export type KohoCsvDocumentListRecord =
  KohoCsvRecord<KohoCsvDocumentListProjection>;
export type KohoCsvContents1Record = KohoCsvRecord<KohoCsvContents1Projection>;
export type KohoCsvContents2Record = KohoCsvRecord<KohoCsvContents2Projection>;

interface KohoCsvResultBase {
  sourceEntryPath: string;
  normalizedEntryPath: string | null;
  packageType: KohoCsvPackageType;
  encoding: KohoCsvEncodingMetadata;
  lineEndings: KohoCsvLineEndingMetadata | null;
  recordCount: number;
  issues: KohoCsvIssue[];
}

export interface KohoCsvAbstractResult extends KohoCsvResultBase {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  logicalFile: "ABSTRACT";
  records: KohoCsvAbstractRecord[];
}

export interface KohoCsvDocumentListResult extends KohoCsvResultBase {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  logicalFile: "DOCUMENT_LIST";
  records: KohoCsvDocumentListRecord[];
}

export interface KohoCsvContents1Result extends KohoCsvResultBase {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  logicalFile: "CONTENTS1";
  records: KohoCsvContents1Record[];
}

export interface KohoCsvContents2Result extends KohoCsvResultBase {
  status: Exclude<KohoCsvStatus, "unsupported_type">;
  logicalFile: "CONTENTS2";
  records: KohoCsvContents2Record[];
}

export interface KohoCsvUnclassifiedFailedResult extends KohoCsvResultBase {
  status: "failed";
  logicalFile: null;
  records: [];
}

export interface KohoCsvUnsupportedResult extends KohoCsvResultBase {
  status: "unsupported_type";
  logicalFile: null;
  records: [];
}

export type KohoCsvUnclassifiedResult =
  | KohoCsvUnclassifiedFailedResult
  | KohoCsvUnsupportedResult;

type KohoCsvClassifiedResult =
  | KohoCsvAbstractResult
  | KohoCsvDocumentListResult
  | KohoCsvContents1Result
  | KohoCsvContents2Result;

type NarrowClassifiedStatus<TResult> =
  TResult extends KohoCsvClassifiedResult
    ?
        | (Omit<TResult, "status"> & { status: "success" })
        | (Omit<TResult, "status"> & { status: "review_required" })
        | (Omit<TResult, "status"> & { status: "failed" })
    : never;

export type KohoCsvParseResult =
  | NarrowClassifiedStatus<KohoCsvClassifiedResult>
  | KohoCsvUnclassifiedResult;

export interface ParsedCsvRecord {
  ordinal: number;
  startLine: number;
  endLine: number;
  rawRecord: string;
  recordDelimiter: "\r\n" | "\n" | "\r" | null;
  sourceCells: string[];
}
