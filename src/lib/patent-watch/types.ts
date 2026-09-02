import type { ComparisonResult } from "../analyze-overlap";
import type { ExtractedClaims } from "../extract-claims";

export type PatentWatchErrorCode =
  | "invalid_watch_setting"
  | "invalid_watch_review_status"
  | "invalid_watch_run_request"
  | "case_not_found"
  | "watch_not_configured"
  | "watch_disabled"
  | "watch_claims_not_ready"
  | "watch_run_in_progress"
  | "watch_run_not_found"
  | "watch_finding_not_found"
  | "watch_corpus_unavailable"
  | "watch_unavailable"
  | "watch_analysis_failed"
  | "watch_internal_error";

export type PatentWatchRunStatus = "running" | "completed" | "failed";
export type PatentWatchAnalysisMode = "none" | "ai" | "fallback";
export type PatentWatchReviewStatus = "unreviewed" | "reviewed";
export type PatentWatchPackageType = "JPA" | "JPB";
export type PatentWatchDocumentKind = "A1" | "P1" | "B1" | "B2";
export type PatentWatchRiskLabel = ComparisonResult["riskLabel"];

export interface PatentWatchCursor {
  runUpdatedAt: string;
  importId: number;
}

export interface PatentWatchSettingInput {
  enabled: boolean;
  monitoringFromDate: string;
}

export interface CaseWatchSetting extends PatentWatchSettingInput {
  watchId: number;
  caseId: number;
  cursorRunUpdatedAt: string | null;
  cursorImportId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatentWatchRunCounts {
  scannedImportRunCount: number;
  scannedDocumentCount: number;
  prefilteredCount: number;
  analyzedCount: number;
  newFindingCount: number;
  fallbackFindingCount: number;
}

export interface CaseWatchRun extends PatentWatchRunCounts {
  runId: number;
  watchId: number;
  status: PatentWatchRunStatus;
  monitoringFromDate: string;
  baseRunUpdatedAt: string | null;
  baseImportId: number | null;
  upperRunUpdatedAt: string | null;
  upperImportId: number | null;
  startedAt: string;
  completedAt: string | null;
  analysisMode: PatentWatchAnalysisMode;
  errorCode: PatentWatchErrorCode | null;
}

export interface PatentWatchAnalysisJson {
  matchedElements: string[];
  unmatchedElements: string[];
  explanation: string;
}

export interface PatentWatchFindingInsert {
  sourceKey: string;
  corpusDocumentId: number | null;
  packageType: PatentWatchPackageType;
  kind: PatentWatchDocumentKind;
  publicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractPreview: string | null;
  lexicalScore: number;
  elementScore: number;
  semanticScore: number;
  structuralScore: number;
  riskLabel: PatentWatchRiskLabel;
  analysisJson: string;
  analysisMode: Exclude<PatentWatchAnalysisMode, "none">;
  reviewStatus: PatentWatchReviewStatus;
}

export interface CaseWatchFinding extends PatentWatchFindingInsert {
  findingId: number;
  watchId: number;
  firstRunId: number;
  firstSeenAt: string;
}

/**
 * 公報corpusからwatch serviceへ渡す最小projection。
 * source hash、entry path、raw XML/CSV、description等は含めない。
 */
export interface PatentWatchCorpusDocument {
  documentId: number;
  importId: number;
  importRunUpdatedAt: string;
  packageType: PatentWatchPackageType;
  kind: PatentWatchDocumentKind;
  publicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractText: string | null;
  claimsText: string;
  contentSha256: string;
}

export interface PatentWatchCorpusBatch {
  documents: PatentWatchCorpusDocument[];
  scannedImportRunCount: number;
  scannedDocumentCount: number;
}

export interface PatentWatchRunStart {
  caseId: number;
  watchId: number;
  runId: number;
  monitoringFromDate: string;
  baseCursor: PatentWatchCursor | null;
  upperCursor: PatentWatchCursor | null;
  extractedClaimsJson: string;
}

export interface PatentWatchRunSuccessInput {
  caseId: number;
  runId: number;
  findings: PatentWatchFindingInsert[];
  counts: PatentWatchRunCounts;
  analysisMode: PatentWatchAnalysisMode;
}

export interface PatentWatchRunFailureInput {
  caseId: number;
  runId: number;
  errorCode: PatentWatchErrorCode;
}

/** serviceが必要とするrepositoryの最小subset。 */
export interface PatentWatchRunRepository {
  startRun(caseId: number): Promise<PatentWatchRunStart>;
  findDocumentsForRun(runId: number): Promise<PatentWatchCorpusBatch>;
  findExistingSourceKeys(
    watchId: number,
    sourceKeys: readonly string[],
  ): Promise<readonly string[]>;
  finalizeRunSuccess(
    input: PatentWatchRunSuccessInput,
  ): Promise<CaseWatchRun>;
  finalizeRunFailure(
    input: PatentWatchRunFailureInput,
  ): Promise<CaseWatchRun | void>;
}

export interface PatentWatchScreeningSummary {
  docId: number;
  publicationNo: string | null;
  title: string | null;
  abstract: string | null;
}

export interface PatentWatchAnalysisDetail
  extends PatentWatchScreeningSummary {
  claimsText: string | null;
}

export interface PatentWatchAnalysisDependencies {
  repository: PatentWatchRunRepository;
  screenPriorArt(
    extracted: ExtractedClaims,
    priorArts: PatentWatchScreeningSummary[],
  ): Promise<{ relevantDocIds: number[]; reasoning: string }>;
  analyzeOverlap(
    extracted: ExtractedClaims,
    priorArts: PatentWatchAnalysisDetail[],
  ): Promise<ComparisonResult[]>;
}
