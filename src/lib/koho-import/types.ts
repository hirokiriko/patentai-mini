import type { KohoPackageParseResult } from "../koho-package";
import type { KohoDocumentKind } from "../koho-xml";

export type KohoImportDocumentKind = Extract<
  KohoDocumentKind,
  "A1" | "P1" | "B1" | "B2"
>;

export type KohoImportDocumentParseStatus = "success" | "review_required";

export interface KohoImportDocumentPlan {
  normalizedEntryPath: string;
  parseStatus: KohoImportDocumentParseStatus;
  kind: KohoImportDocumentKind;
  publicationNumber: string;
  applicationNumber: string;
  publicationDate: string;
  registrationNumber: string | null;
  registrationDate: string | null;
  inventionTitle: string;
  abstractText: string | null;
  claimsText: string;
  applicantsJson: string;
  ipcJson: string;
  fiJson: string;
  parseIssuesJson: string;
  sourceMetadataJson: string;
  contentSha256: string;
}

export interface KohoImportPlan {
  packageType: KohoPackageParseResult["packageType"];
  sourceSha256: string;
  packageStatus: KohoPackageParseResult["status"];
  documentCount: number;
  amendmentCount: number;
  nestedSt26Count: number;
  countsJson: string;
  issuesJson: string;
  documents: KohoImportDocumentPlan[];
}

export interface BuildKohoImportPlanInput {
  packageResult: KohoPackageParseResult;
  sourceSha256: string;
}

export type KohoImportPlanValidationErrorCode =
  | "invalid_plan_shape"
  | "invalid_document_shape"
  | "invalid_source_sha256"
  | "invalid_package_type"
  | "invalid_package_status"
  | "invalid_document_count"
  | "invalid_counts"
  | "invalid_counts_json"
  | "invalid_issues_json"
  | "invalid_applicants_json"
  | "invalid_ipc_json"
  | "invalid_fi_json"
  | "invalid_parse_issues_json"
  | "invalid_source_metadata_json"
  | "invalid_primary_xml_result"
  | "invalid_entry_id"
  | "invalid_entry_type"
  | "invalid_document_status"
  | "invalid_document_kind"
  | "invalid_issue_status"
  | "invalid_issue_section"
  | "invalid_normalized_entry_path"
  | "duplicate_normalized_entry_path"
  | "inconsistent_source_metadata"
  | "invalid_content_sha256"
  | "content_sha256_mismatch";

/** Validation details intentionally omit source content and rejected values. */
export class KohoImportPlanValidationError extends Error {
  readonly code: KohoImportPlanValidationErrorCode;

  constructor(code: KohoImportPlanValidationErrorCode) {
    super(`Koho import plan validation failed: ${code}`);
    this.name = "KohoImportPlanValidationError";
    this.code = code;
  }
}
