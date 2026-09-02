import type {
  KohoImportDocumentPlan,
  KohoImportPlan,
} from "@/lib/koho-import";
import type {
  KohoCorpusAttachResult,
  KohoCorpusSearchSummary,
} from "@/lib/koho-corpus/domain";
import type {
  CaseWatchFinding,
  CaseWatchRun,
  CaseWatchSetting,
  PatentWatchErrorCode,
  PatentWatchRunRepository,
} from "@/lib/patent-watch/types";

/**
 * リポジトリ層の型定義。
 * DB 実装（Drizzle/Turso, Firebase, DynamoDB 等）に依存しない
 * データアクセスのインターフェースを定義する。
 */

// --- Entity types ---

export interface Case {
  caseId: number;
  title: string;
  status: string;
  baseApplicationMode: boolean;
  baseApplicationNumber: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DraftKind = "main" | "base" | "addition";

export interface DraftPatent {
  draftId: number;
  caseId: number;
  kind: DraftKind;
  sourceFilePath: string | null;
  parsedText: string | null;
  extractedClaimsJson: string | null;
}

export interface SearchQuerySet {
  querySetId: number;
  caseId: number;
  broadQuery: string | null;
  balancedQuery: string | null;
  narrowQuery: string | null;
  rationaleJson: string | null;
}

export interface PriorArtDocument {
  docId: number;
  caseId: number;
  publicationNo: string | null;
  title: string | null;
  abstract: string | null;
  claimsText: string | null;
  sourceCsvRowJson: string | null;
  normalizedElementsJson: string | null;
}

export interface ComparisonResult {
  resultId: number;
  caseId: number;
  draftClaimId: string | null;
  priorDocId: number | null;
  lexicalScore: number | null;
  semanticScore: number | null;
  structuralScore: number | null;
  matchedElementsJson: string | null;
  riskLabel: string | null;
}

export interface KohoImportRun {
  importId: number;
  packageType: KohoImportPlan["packageType"];
  sourceSha256: string;
  packageStatus: KohoImportPlan["packageStatus"];
  documentCount: number;
  amendmentCount: number;
  nestedSt26Count: number;
  countsJson: string;
  issuesJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface KohoImportDocument {
  documentId: number;
  importId: number;
  normalizedEntryPath: string;
  parseStatus: KohoImportDocumentPlan["parseStatus"];
  kind: KohoImportDocumentPlan["kind"];
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

export interface KohoImportSaveResult {
  run: KohoImportRun;
  savedDocumentCount: number;
}

export type KohoImportRepositoryValidationErrorCode =
  | "invalid_package_type"
  | "invalid_source_sha256"
  | "invalid_package_status"
  | "invalid_document_count"
  | "invalid_document_parse_status"
  | "invalid_document_kind"
  | "invalid_normalized_entry_path"
  | "duplicate_normalized_entry_path"
  | "invalid_content_sha256"
  | "content_sha256_mismatch"
  | "invalid_import_id"
  | "invalid_document_payload";

export class KohoImportRepositoryValidationError extends Error {
  readonly code: KohoImportRepositoryValidationErrorCode;

  constructor(code: KohoImportRepositoryValidationErrorCode) {
    super(`Koho import repository validation failed: ${code}`);
    this.name = "KohoImportRepositoryValidationError";
    this.code = code;
  }
}

export type PatentWatchRepositoryErrorCode = PatentWatchErrorCode;

export class PatentWatchRepositoryError extends Error {
  readonly code: PatentWatchRepositoryErrorCode;

  constructor(code: PatentWatchRepositoryErrorCode) {
    super(`Patent watch repository failed: ${code}`);
    this.name = "PatentWatchRepositoryError";
    this.code = code;
  }
}

// --- Repository interfaces ---

export interface CaseRepository {
  findAll(): Promise<Case[]>;
  findById(caseId: number): Promise<Case | null>;
  create(data: {
    title: string;
    baseApplicationMode?: boolean;
    baseApplicationNumber?: string | null;
  }): Promise<Case>;
  update(
    caseId: number,
    data: Partial<Pick<Case, "title" | "status" | "baseApplicationMode" | "baseApplicationNumber">>
  ): Promise<Case | null>;
  remove(caseId: number): Promise<boolean>;
}

export interface DraftPatentRepository {
  findByCaseId(caseId: number): Promise<DraftPatent[]>;
  create(data: {
    caseId: number;
    kind?: DraftKind;
    sourceFilePath: string | null;
    parsedText?: string | null;
  }): Promise<DraftPatent>;
  upsertMain(data: {
    caseId: number;
    sourceFilePath: string | null;
    parsedText: string;
  }): Promise<DraftPatent>;
  updateExtractedClaims(draftId: number, json: string): Promise<DraftPatent | null>;
}

export interface SearchQuerySetRepository {
  findByCaseId(caseId: number): Promise<SearchQuerySet[]>;
  create(data: {
    caseId: number;
    broadQuery: string;
    balancedQuery: string;
    narrowQuery: string;
    rationaleJson: string;
  }): Promise<SearchQuerySet>;
}

export interface PriorArtDocumentRepository {
  findByCaseId(caseId: number): Promise<PriorArtDocument[]>;
  createMany(docs: Omit<PriorArtDocument, "docId">[]): Promise<number>;
  // 同 caseId 内で同じ publicationNo の既存レコードがあれば UPDATE、なければ INSERT。
  // publicationNo が null の docs は常に INSERT する。
  upsertManyByPublicationNo(
    caseId: number,
    docs: Omit<PriorArtDocument, "docId">[]
  ): Promise<{ inserted: number; updated: number }>;
  // 指定 caseId に属する docId のみ削除する（他案件の docId を渡しても削除されない）。
  deleteByIds(caseId: number, docIds: number[]): Promise<number>;
}

export interface ComparisonResultRepository {
  findByCaseId(caseId: number): Promise<ComparisonResult[]>;
  replaceByCaseId(caseId: number, results: Omit<ComparisonResult, "resultId">[]): Promise<number>;
}

export interface KohoImportRepository {
  savePlan(plan: KohoImportPlan): Promise<KohoImportSaveResult>;
  findRunBySource(
    packageType: KohoImportPlan["packageType"],
    sourceSha256: string,
  ): Promise<KohoImportRun | null>;
  findDocumentsByRunId(importId: number): Promise<KohoImportDocument[]>;
}

export interface KohoCorpusRepository {
  searchForCase(
    caseId: number,
    query: string,
    limit: number,
  ): Promise<KohoCorpusSearchSummary[]>;
  attachToCase(
    caseId: number,
    documentIds: number[],
  ): Promise<KohoCorpusAttachResult>;
}

export interface PatentWatchRepository extends PatentWatchRunRepository {
  getSetting(caseId: number): Promise<CaseWatchSetting | null>;
  upsertSetting(
    caseId: number,
    data: Pick<CaseWatchSetting, "enabled" | "monitoringFromDate">,
  ): Promise<CaseWatchSetting>;
  getRun(caseId: number, runId: number): Promise<CaseWatchRun | null>;
  listRuns(caseId: number, limit: number): Promise<CaseWatchRun[]>;
  listFindings(
    caseId: number,
    options: { runId?: number; limit: number },
  ): Promise<CaseWatchFinding[]>;
  countUnreviewedFindings(caseId: number): Promise<number>;
  updateFindingReviewStatus(
    caseId: number,
    findingId: number,
    reviewStatus: CaseWatchFinding["reviewStatus"],
  ): Promise<CaseWatchFinding | null>;
}
