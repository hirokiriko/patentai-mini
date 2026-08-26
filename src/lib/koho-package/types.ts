import type {
  KohoCsvContractIssueCode,
  KohoCsvContractLimits,
  KohoCsvContractParseResult,
} from "../koho-csv";
import type {
  KohoIssueCode,
  KohoXmlParseInput,
  KohoXmlParseResult,
} from "../koho-xml";
import type {
  KohoZipEntryRole,
  KohoZipErrorCode,
  KohoZipLimits,
  KohoZipPathCandidate,
  KohoZipSource,
  KohoZipSummary,
} from "../koho-zip";

export type KohoPackageType = "JPA" | "JPB";

export type KohoPackageStatus = "success" | "review_required" | "failed";

export interface KohoPackageLimits {
  zip: KohoZipLimits;
  csv: KohoCsvContractLimits;
  xml: KohoXmlParseInput["limits"];
}

export interface KohoPackageParseInput {
  packageType: KohoPackageType;
  source: KohoZipSource;
  limits: KohoPackageLimits;
}

export type KohoPackageSection =
  | "P_A1"
  | "P_A5"
  | "P_P1"
  | "P_P5"
  | "P_B1";

export type KohoPackageEntryProcessing =
  | "parsed_csv"
  | "parsed_primary_xml"
  | "counted_nested_xml"
  | "ignored_attachment"
  | "unclassified"
  | "unreadable";

export type KohoPackageEntryStatus = KohoPackageStatus | "not_processed";

export interface KohoPackageManifestEntry {
  entryId: number;
  normalizedPath: string;
  role: KohoZipEntryRole;
  pathCandidate: KohoZipPathCandidate;
  canRead: boolean;
  processing: KohoPackageEntryProcessing;
  status: KohoPackageEntryStatus;
}

export interface KohoPackageCsvResult {
  entryId: number;
  normalizedPath: string;
  result: KohoCsvContractParseResult;
}

export interface KohoPackageXmlResult {
  entryId: number;
  normalizedPath: string;
  result: KohoXmlParseResult;
}

export type KohoPackageIssueCode =
  | "invalid_limits"
  | "zip_open_failed"
  | "zip_entry_read_failed"
  | "reader_close_failed"
  | "required_csv_missing"
  | "required_csv_unreadable"
  | "csv_parse_failed"
  | "unclassified_csv_entry"
  | "unclassified_xml_entry"
  | "unreadable_attachment"
  | "package_section_mismatch"
  | "document_list_match_missing"
  | "document_list_match_ambiguous"
  | "document_list_orphan"
  | "document_list_count_mismatch"
  | "abstract_summary_missing"
  | "abstract_summary_ambiguous"
  | "abstract_count_mismatch"
  | "contents_file_missing"
  | "contents_record_missing"
  | "contents_record_ambiguous"
  | "contents_record_orphan"
  | "primary_xml_parse_failed"
  | "primary_xml_unconfirmed";

export type KohoPackageIssueCause =
  | { source: "zip"; code: KohoZipErrorCode }
  | { source: "csv"; code: KohoCsvContractIssueCode }
  | { source: "xml"; code: KohoIssueCode };

export interface KohoPackageIssue {
  code: KohoPackageIssueCode;
  status: Exclude<KohoPackageStatus, "success">;
  message: string;
  entryId?: number;
  normalizedPath?: string;
  section?: KohoPackageSection;
  recordNumber?: number;
  cause?: KohoPackageIssueCause;
}

export interface KohoPackageSectionCountSummary {
  primaryXmlCandidates: number;
  finalXmlResults: number;
  confirmedFullPublications: number;
  confirmedAmendments: number;
  documentFolders: number;
  contents1Records: number;
  contents2Records: number;
  attachmentCount: number;
  roleCounts: Readonly<Record<KohoZipEntryRole, number>>;
}

export interface KohoPackageCountSummary {
  primaryXmlCandidates: number;
  finalXmlResults: number;
  confirmedFullPublications: number;
  confirmedAmendments: number;
  nestedXmlCandidates: number;
  documentFolders: number;
  documentListRecords: number;
  roleCounts: Readonly<Record<KohoZipEntryRole, number>>;
  bySection: Readonly<Record<KohoPackageSection, KohoPackageSectionCountSummary>>;
}

export interface KohoPackageParseResult {
  status: KohoPackageStatus;
  packageType: KohoPackageType;
  zipSummary: KohoZipSummary | null;
  manifest: KohoPackageManifestEntry[];
  csvResults: KohoPackageCsvResult[];
  primaryXmlResults: KohoPackageXmlResult[];
  counts: KohoPackageCountSummary;
  issues: KohoPackageIssue[];
}
