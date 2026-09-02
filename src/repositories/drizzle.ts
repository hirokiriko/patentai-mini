import { db } from "../db";
import {
  cases,
  draftPatents,
  searchQuerySets,
  priorArtDocuments,
  comparisonResults,
  kohoImportDocuments,
  kohoImportRuns,
  caseWatchSettings,
  caseWatchRuns,
  caseWatchFindings,
} from "../db/schema";
import {
  assertKohoImportDocumentPlan,
  assertKohoImportRunContract,
  createKohoImportPlanSnapshot,
  KohoImportPlanValidationError,
  type KohoImportDocumentPlan,
  type KohoImportRunContract,
} from "../lib/koho-import";
import {
  buildKohoCorpusAttachPlan,
  KohoCorpusDomainError,
  type KohoCorpusSearchSummary,
  type KohoCorpusSourceDocument,
} from "../lib/koho-corpus/domain";
import {
  eq,
  desc,
  asc,
  and,
  inArray,
  or,
  sql,
  gt,
  gte,
  lt,
  lte,
} from "drizzle-orm";
import {
  KohoImportRepositoryValidationError,
  PatentWatchRepositoryError,
} from "./types";
import type {
  CaseRepository,
  DraftPatentRepository,
  SearchQuerySetRepository,
  PriorArtDocumentRepository,
  ComparisonResultRepository,
  DraftKind,
  KohoImportDocument,
  KohoImportRepository,
  KohoImportRun,
  KohoCorpusRepository,
  PatentWatchRepository,
} from "./types";
import type {
  CaseWatchFinding,
  CaseWatchRun,
  CaseWatchSetting,
  PatentWatchAnalysisMode,
  PatentWatchCursor,
  PatentWatchCorpusDocument,
  PatentWatchDocumentKind,
  PatentWatchErrorCode,
  PatentWatchPackageType,
  PatentWatchReviewStatus,
  PatentWatchRiskLabel,
  PatentWatchRunStatus,
} from "../lib/patent-watch/types";
import {
  comparePatentWatchCursors,
  isValidPatentWatchTimestamp,
} from "../lib/patent-watch/domain";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const KOHO_PACKAGE_TYPES = new Set<string>(["JPA", "JPB"]);
const KOHO_PACKAGE_STATUSES = new Set<string>([
  "success",
  "review_required",
  "failed",
]);
const KOHO_DOCUMENT_PARSE_STATUSES = new Set<string>([
  "success",
  "review_required",
]);
const KOHO_DOCUMENT_KINDS = new Set<string>(["A1", "P1", "B1", "B2"]);

function invalid(
  code: ConstructorParameters<typeof KohoImportRepositoryValidationError>[0],
): never {
  throw new KohoImportRepositoryValidationError(code);
}

function assertPackageType(
  value: unknown,
): asserts value is KohoImportRun["packageType"] {
  if (typeof value !== "string" || !KOHO_PACKAGE_TYPES.has(value)) {
    invalid("invalid_package_type");
  }
}

function assertPackageStatus(
  value: unknown,
): asserts value is KohoImportRun["packageStatus"] {
  if (typeof value !== "string" || !KOHO_PACKAGE_STATUSES.has(value)) {
    invalid("invalid_package_status");
  }
}

function assertDocumentParseStatus(
  value: unknown,
): asserts value is KohoImportDocument["parseStatus"] {
  if (
    typeof value !== "string" ||
    !KOHO_DOCUMENT_PARSE_STATUSES.has(value)
  ) {
    invalid("invalid_document_parse_status");
  }
}

function assertDocumentKind(
  value: unknown,
): asserts value is KohoImportDocument["kind"] {
  if (typeof value !== "string" || !KOHO_DOCUMENT_KINDS.has(value)) {
    invalid("invalid_document_kind");
  }
}

function assertSha256(
  value: unknown,
  code: "invalid_source_sha256" | "invalid_content_sha256",
): asserts value is string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    invalid(code);
  }
}

function assertImportId(importId: unknown): asserts importId is number {
  if (!Number.isSafeInteger(importId) || (importId as number) <= 0) {
    invalid("invalid_import_id");
  }
}

function rethrowRepositoryValidation(error: unknown): never {
  if (!(error instanceof KohoImportPlanValidationError)) throw error;
  switch (error.code) {
    case "invalid_package_type":
    case "invalid_source_sha256":
    case "invalid_package_status":
    case "invalid_document_count":
    case "invalid_document_kind":
    case "invalid_normalized_entry_path":
    case "duplicate_normalized_entry_path":
    case "invalid_content_sha256":
    case "content_sha256_mismatch":
      invalid(error.code);
    case "invalid_document_status":
      invalid("invalid_document_parse_status");
    default:
      invalid("invalid_document_payload");
  }
}

function validateRepositoryContract<T>(validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    rethrowRepositoryValidation(error);
  }
}

function validatedPlanSnapshot(
  plan: Parameters<KohoImportRepository["savePlan"]>[0] | null | undefined,
): Parameters<KohoImportRepository["savePlan"]>[0] {
  return validateRepositoryContract(() => createKohoImportPlanSnapshot(plan));
}

function toKohoImportRun(
  row: typeof kohoImportRuns.$inferSelect,
): KohoImportRun {
  const packageType = row.packageType;
  const packageStatus = row.packageStatus;
  assertImportId(row.importId);
  assertPackageType(packageType);
  assertSha256(row.sourceSha256, "invalid_source_sha256");
  assertPackageStatus(packageStatus);
  const contract: KohoImportRunContract = {
    packageType,
    sourceSha256: row.sourceSha256,
    packageStatus,
    documentCount: row.documentCount,
    amendmentCount: row.amendmentCount,
    nestedSt26Count: row.nestedSt26Count,
    countsJson: row.countsJson,
    issuesJson: row.issuesJson,
  };
  validateRepositoryContract(() => assertKohoImportRunContract(contract));
  if (typeof row.createdAt !== "string" || typeof row.updatedAt !== "string") {
    invalid("invalid_document_payload");
  }
  return { ...row, packageType, packageStatus };
}

function toKohoImportDocument(
  row: typeof kohoImportDocuments.$inferSelect,
  packageType: KohoImportRun["packageType"],
): KohoImportDocument {
  const parseStatus = row.parseStatus;
  const kind = row.kind;
  assertImportId(row.documentId);
  assertImportId(row.importId);
  assertDocumentParseStatus(parseStatus);
  assertDocumentKind(kind);
  const document: KohoImportDocumentPlan = {
    normalizedEntryPath: row.normalizedEntryPath,
    parseStatus,
    kind,
    publicationNumber: row.publicationNumber,
    applicationNumber: row.applicationNumber,
    publicationDate: row.publicationDate,
    registrationNumber: row.registrationNumber,
    registrationDate: row.registrationDate,
    inventionTitle: row.inventionTitle,
    abstractText: row.abstractText,
    claimsText: row.claimsText,
    applicantsJson: row.applicantsJson,
    ipcJson: row.ipcJson,
    fiJson: row.fiJson,
    parseIssuesJson: row.parseIssuesJson,
    sourceMetadataJson: row.sourceMetadataJson,
    contentSha256: row.contentSha256,
  };
  validateRepositoryContract(() =>
    assertKohoImportDocumentPlan(document, packageType),
  );
  return { documentId: row.documentId, importId: row.importId, ...document };
}

function unavailableKohoCorpus(): KohoCorpusDomainError {
  return new KohoCorpusDomainError("koho_corpus_unavailable");
}

function rethrowKohoCorpusError(error: unknown): never {
  if (error instanceof KohoCorpusDomainError) throw error;
  throw unavailableKohoCorpus();
}

function isValidYyyyMmDd(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
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
  return day <= daysInMonth[month - 1];
}

function normalizeKohoCorpusPublicationDate(value: string): string {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
  if (!match) throw unavailableKohoCorpus();
  const normalized = `${match[1]}${match[2]}${match[3]}`;
  if (!isValidYyyyMmDd(normalized)) throw unavailableKohoCorpus();
  return normalized;
}

const PATENT_WATCH_RUN_STATUSES = new Set<PatentWatchRunStatus>([
  "running",
  "completed",
  "failed",
]);
const PATENT_WATCH_ANALYSIS_MODES = new Set<PatentWatchAnalysisMode>([
  "none",
  "ai",
  "fallback",
]);
const PATENT_WATCH_REVIEW_STATUSES = new Set<PatentWatchReviewStatus>([
  "unreviewed",
  "reviewed",
]);
const PATENT_WATCH_PACKAGE_TYPES = new Set<PatentWatchPackageType>([
  "JPA",
  "JPB",
]);
const PATENT_WATCH_DOCUMENT_KINDS = new Set<PatentWatchDocumentKind>([
  "A1",
  "P1",
  "B1",
  "B2",
]);
const PATENT_WATCH_RISK_LABELS = new Set<PatentWatchRiskLabel>([
  "High",
  "Medium",
  "Low",
  "Unknown",
]);
const PATENT_WATCH_ERROR_CODES = new Set<PatentWatchErrorCode>([
  "invalid_watch_setting",
  "invalid_watch_review_status",
  "invalid_watch_run_request",
  "case_not_found",
  "watch_not_configured",
  "watch_disabled",
  "watch_claims_not_ready",
  "watch_run_in_progress",
  "watch_run_not_found",
  "watch_finding_not_found",
  "watch_corpus_unavailable",
  "watch_unavailable",
  "watch_analysis_failed",
  "watch_internal_error",
]);
const PATENT_WATCH_LIST_LIMIT_MAX = 100;
const PATENT_WATCH_SOURCE_KEY_BATCH_SIZE = 1_000;
// Serializes corpus persistence and watch upper-cursor capture. The import
// timestamp is assigned only after this transaction-scoped lock is acquired.
const KOHO_IMPORT_WATCH_CURSOR_LOCK_ID = 70_000_001;

function patentWatchError(code: PatentWatchErrorCode): never {
  throw new PatentWatchRepositoryError(code);
}

function rethrowPatentWatchRepositoryError(
  error: unknown,
  fallback: "watch_unavailable" | "watch_corpus_unavailable",
): never {
  if (error instanceof PatentWatchRepositoryError) throw error;
  patentWatchError(fallback);
}

function assertPatentWatchId(
  value: unknown,
  code:
    | "case_not_found"
    | "watch_not_configured"
    | "watch_run_not_found"
    | "watch_finding_not_found",
): asserts value is number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > POSTGRES_INTEGER_MAX
  ) {
    patentWatchError(code);
  }
}

function assertPatentWatchTimestamp(
  value: unknown,
  fallback: "watch_unavailable" | "watch_corpus_unavailable",
): asserts value is string {
  if (
    typeof value !== "string" ||
    !isValidPatentWatchTimestamp(value)
  ) {
    patentWatchError(fallback);
  }
}

function toPatentWatchCursor(
  runUpdatedAt: string | null,
  importId: number | null,
  fallback: "watch_unavailable" | "watch_corpus_unavailable",
): PatentWatchCursor | null {
  if (runUpdatedAt === null && importId === null) return null;
  if (runUpdatedAt === null || importId === null) {
    patentWatchError(fallback);
  }
  assertPatentWatchTimestamp(runUpdatedAt, fallback);
  if (
    !Number.isSafeInteger(importId) ||
    importId < 1 ||
    importId > POSTGRES_INTEGER_MAX
  ) {
    patentWatchError(fallback);
  }
  return { runUpdatedAt, importId };
}

function comparePatentWatchCursor(
  left: PatentWatchCursor,
  right: PatentWatchCursor,
): number {
  return comparePatentWatchCursors(left, right);
}

function assertPatentWatchCount(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    patentWatchError("watch_unavailable");
  }
}

function toCaseWatchSetting(
  row: typeof caseWatchSettings.$inferSelect,
): CaseWatchSetting {
  assertPatentWatchId(row.watchId, "watch_not_configured");
  assertPatentWatchId(row.caseId, "case_not_found");
  if (
    typeof row.enabled !== "boolean" ||
    !isValidYyyyMmDd(row.monitoringFromDate)
  ) {
    patentWatchError("watch_unavailable");
  }
  toPatentWatchCursor(
    row.cursorRunUpdatedAt,
    row.cursorImportId,
    "watch_unavailable",
  );
  assertPatentWatchTimestamp(row.createdAt, "watch_unavailable");
  assertPatentWatchTimestamp(row.updatedAt, "watch_unavailable");
  return row;
}

function toCaseWatchRun(row: typeof caseWatchRuns.$inferSelect): CaseWatchRun {
  assertPatentWatchId(row.runId, "watch_run_not_found");
  assertPatentWatchId(row.watchId, "watch_not_configured");
  if (!PATENT_WATCH_RUN_STATUSES.has(row.status as PatentWatchRunStatus)) {
    patentWatchError("watch_unavailable");
  }
  if (!isValidYyyyMmDd(row.monitoringFromDate)) {
    patentWatchError("watch_unavailable");
  }
  if (
    !PATENT_WATCH_ANALYSIS_MODES.has(
      row.analysisMode as PatentWatchAnalysisMode,
    )
  ) {
    patentWatchError("watch_unavailable");
  }
  toPatentWatchCursor(
    row.baseCursorRunUpdatedAt,
    row.baseCursorImportId,
    "watch_unavailable",
  );
  toPatentWatchCursor(
    row.upperCursorRunUpdatedAt,
    row.upperCursorImportId,
    "watch_unavailable",
  );
  assertPatentWatchTimestamp(row.startedAt, "watch_unavailable");
  if (row.completedAt !== null) {
    assertPatentWatchTimestamp(row.completedAt, "watch_unavailable");
  }
  for (const count of [
    row.scannedImportRunCount,
    row.scannedDocumentCount,
    row.prefilteredCount,
    row.analyzedCount,
    row.newFindingCount,
    row.fallbackFindingCount,
  ]) {
    assertPatentWatchCount(count);
  }
  if (
    row.errorCode !== null &&
    !PATENT_WATCH_ERROR_CODES.has(row.errorCode as PatentWatchErrorCode)
  ) {
    patentWatchError("watch_unavailable");
  }

  return {
    runId: row.runId,
    watchId: row.watchId,
    status: row.status as PatentWatchRunStatus,
    monitoringFromDate: row.monitoringFromDate,
    baseRunUpdatedAt: row.baseCursorRunUpdatedAt,
    baseImportId: row.baseCursorImportId,
    upperRunUpdatedAt: row.upperCursorRunUpdatedAt,
    upperImportId: row.upperCursorImportId,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    scannedImportRunCount: row.scannedImportRunCount,
    scannedDocumentCount: row.scannedDocumentCount,
    prefilteredCount: row.prefilteredCount,
    analyzedCount: row.analyzedCount,
    newFindingCount: row.newFindingCount,
    fallbackFindingCount: row.fallbackFindingCount,
    analysisMode: row.analysisMode as PatentWatchAnalysisMode,
    errorCode: row.errorCode as PatentWatchErrorCode | null,
  };
}

function toCaseWatchFinding(
  row: typeof caseWatchFindings.$inferSelect,
): CaseWatchFinding {
  assertPatentWatchId(row.findingId, "watch_finding_not_found");
  assertPatentWatchId(row.watchId, "watch_not_configured");
  assertPatentWatchId(row.firstRunId, "watch_run_not_found");
  if (
    !SHA256_PATTERN.test(row.sourceKey) ||
    !PATENT_WATCH_PACKAGE_TYPES.has(
      row.packageType as PatentWatchPackageType,
    ) ||
    !PATENT_WATCH_DOCUMENT_KINDS.has(row.kind as PatentWatchDocumentKind) ||
    !isValidYyyyMmDd(row.publicationDate) ||
    !PATENT_WATCH_RISK_LABELS.has(row.riskLabel as PatentWatchRiskLabel) ||
    !PATENT_WATCH_ANALYSIS_MODES.has(
      row.analysisMode as PatentWatchAnalysisMode,
    ) ||
    row.analysisMode === "none" ||
    !PATENT_WATCH_REVIEW_STATUSES.has(
      row.reviewStatus as PatentWatchReviewStatus,
    )
  ) {
    patentWatchError("watch_unavailable");
  }
  for (const score of [
    row.lexicalScore,
    row.elementScore,
    row.semanticScore,
    row.structuralScore,
  ]) {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      patentWatchError("watch_unavailable");
    }
  }
  assertPatentWatchAnalysisJson(row.analysisJson, "watch_unavailable");
  assertPatentWatchTimestamp(row.firstSeenAt, "watch_unavailable");

  return {
    ...row,
    packageType: row.packageType as PatentWatchPackageType,
    kind: row.kind as PatentWatchDocumentKind,
    riskLabel: row.riskLabel as PatentWatchRiskLabel,
    analysisMode: row.analysisMode as Exclude<PatentWatchAnalysisMode, "none">,
    reviewStatus: row.reviewStatus as PatentWatchReviewStatus,
  };
}

function normalizePatentWatchListLimit(limit: number): number {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > PATENT_WATCH_LIST_LIMIT_MAX
  ) {
    patentWatchError("watch_internal_error");
  }
  return limit;
}

function assertPatentWatchAnalysisJson(
  value: unknown,
  errorCode: "watch_internal_error" | "watch_unavailable" =
    "watch_internal_error",
): asserts value is string {
  if (typeof value !== "string") {
    patentWatchError(errorCode);
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      patentWatchError(errorCode);
    }
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).join(",") !==
        "matchedElements,unmatchedElements,explanation" ||
      !Array.isArray(record.matchedElements) ||
      !record.matchedElements.every((item) => typeof item === "string") ||
      !Array.isArray(record.unmatchedElements) ||
      !record.unmatchedElements.every((item) => typeof item === "string") ||
      typeof record.explanation !== "string"
    ) {
      patentWatchError(errorCode);
    }
    if (
      value !==
      JSON.stringify({
        matchedElements: record.matchedElements,
        unmatchedElements: record.unmatchedElements,
        explanation: record.explanation,
      })
    ) {
      patentWatchError(errorCode);
    }
  } catch (error) {
    if (error instanceof PatentWatchRepositoryError) throw error;
    patentWatchError(errorCode);
  }
}

function assertPatentWatchFindingInsert(
  finding: Parameters<
    PatentWatchRepository["finalizeRunSuccess"]
  >[0]["findings"][number],
): void {
  if (
    !SHA256_PATTERN.test(finding.sourceKey) ||
    (finding.corpusDocumentId !== null &&
      (!Number.isSafeInteger(finding.corpusDocumentId) ||
        finding.corpusDocumentId < 1 ||
        finding.corpusDocumentId > POSTGRES_INTEGER_MAX)) ||
    !PATENT_WATCH_PACKAGE_TYPES.has(finding.packageType) ||
    !PATENT_WATCH_DOCUMENT_KINDS.has(finding.kind) ||
    !isValidYyyyMmDd(finding.publicationDate) ||
    !PATENT_WATCH_RISK_LABELS.has(finding.riskLabel) ||
    (finding.analysisMode !== "ai" && finding.analysisMode !== "fallback") ||
    finding.reviewStatus !== "unreviewed" ||
    typeof finding.publicationNumber !== "string" ||
    finding.publicationNumber.length === 0 ||
    typeof finding.inventionTitle !== "string" ||
    finding.inventionTitle.length === 0 ||
    (finding.abstractPreview !== null &&
      typeof finding.abstractPreview !== "string")
  ) {
    patentWatchError("watch_internal_error");
  }
  for (const score of [
    finding.lexicalScore,
    finding.elementScore,
    finding.semanticScore,
    finding.structuralScore,
  ]) {
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      patentWatchError("watch_internal_error");
    }
  }
  assertPatentWatchAnalysisJson(finding.analysisJson);
}

export function toKohoCorpusSourceDocument(
  documentRow: typeof kohoImportDocuments.$inferSelect,
  runRow: typeof kohoImportRuns.$inferSelect,
): KohoCorpusSourceDocument {
  const run = toKohoImportRun(runRow);
  const document = toKohoImportDocument(documentRow, run.packageType);
  const publicationDate = normalizeKohoCorpusPublicationDate(
    document.publicationDate,
  );
  return {
    ...document,
    publicationDate,
    packageType: run.packageType,
    sourceSha256: run.sourceSha256,
  };
}

function toKohoCorpusSearchSummary(
  document: KohoCorpusSourceDocument,
): KohoCorpusSearchSummary {
  return {
    documentId: document.documentId,
    packageType: document.packageType,
    parseStatus: document.parseStatus,
    kind: document.kind,
    publicationNumber: document.publicationNumber,
    applicationNumber: document.applicationNumber,
    publicationDate: document.publicationDate,
    inventionTitle: document.inventionTitle,
    abstractPreview:
      document.abstractText === null
        ? null
        : Array.from(document.abstractText).slice(0, 300).join(""),
  };
}

function assertNoDuplicateExistingPublicationNumbers(
  documents: readonly (typeof priorArtDocuments.$inferSelect)[],
): void {
  const publicationNumbers = new Set<string>();
  for (const document of documents) {
    if (document.publicationNo === null) continue;
    if (publicationNumbers.has(document.publicationNo)) {
      throw unavailableKohoCorpus();
    }
    publicationNumbers.add(document.publicationNo);
  }
}

export const caseRepo: CaseRepository = {
  async findAll() {
    return db.select().from(cases).orderBy(desc(cases.createdAt));
  },
  async findById(caseId) {
    const [row] = await db.select().from(cases).where(eq(cases.caseId, caseId));
    return row ?? null;
  },
  async create(data) {
    const [row] = await db
      .insert(cases)
      .values({
        title: data.title,
        baseApplicationMode: data.baseApplicationMode ?? false,
        baseApplicationNumber: data.baseApplicationNumber ?? null,
      })
      .returning();
    return row;
  },
  async update(caseId, data) {
    const updates: Record<string, unknown> = { updatedAt: sql`now()` };
    if (data.title !== undefined) updates.title = data.title;
    if (data.status !== undefined) updates.status = data.status;
    if (data.baseApplicationMode !== undefined)
      updates.baseApplicationMode = data.baseApplicationMode;
    if (data.baseApplicationNumber !== undefined)
      updates.baseApplicationNumber = data.baseApplicationNumber;
    const [row] = await db.update(cases).set(updates).where(eq(cases.caseId, caseId)).returning();
    return row ?? null;
  },
  async remove(caseId) {
    return db.transaction(async (tx) => {
      await tx.delete(comparisonResults).where(eq(comparisonResults.caseId, caseId));
      await tx.delete(searchQuerySets).where(eq(searchQuerySets.caseId, caseId));
      await tx.delete(draftPatents).where(eq(draftPatents.caseId, caseId));
      await tx.delete(priorArtDocuments).where(eq(priorArtDocuments.caseId, caseId));

      const [row] = await tx.delete(cases).where(eq(cases.caseId, caseId)).returning();
      return !!row;
    });
  },
};

export const draftPatentRepo: DraftPatentRepository = {
  async findByCaseId(caseId) {
    const rows = await db.select().from(draftPatents).where(eq(draftPatents.caseId, caseId));
    return rows.map((r) => ({ ...r, kind: r.kind as DraftKind }));
  },
  async create(data) {
    const [row] = await db
      .insert(draftPatents)
      .values({
        caseId: data.caseId,
        kind: data.kind ?? "main",
        sourceFilePath: data.sourceFilePath,
        parsedText: data.parsedText ?? null,
      })
      .returning();
    return { ...row, kind: row.kind as DraftKind };
  },
  async upsertMain(data) {
    // 統合済みメインドラフトを 1 件に保つ。既存があれば更新、なければ作成。
    const existing = await db
      .select()
      .from(draftPatents)
      .where(and(eq(draftPatents.caseId, data.caseId), eq(draftPatents.kind, "main")));
    if (existing.length > 0) {
      const [row] = await db
        .update(draftPatents)
        .set({
          sourceFilePath: data.sourceFilePath,
          parsedText: data.parsedText,
          extractedClaimsJson: null,
        })
        .where(eq(draftPatents.draftId, existing[0].draftId))
        .returning();
      return { ...row, kind: row.kind as DraftKind };
    }
    const [row] = await db
      .insert(draftPatents)
      .values({
        caseId: data.caseId,
        kind: "main",
        sourceFilePath: data.sourceFilePath,
        parsedText: data.parsedText,
      })
      .returning();
    return { ...row, kind: row.kind as DraftKind };
  },
  async updateExtractedClaims(draftId, json) {
    const [row] = await db
      .update(draftPatents)
      .set({ extractedClaimsJson: json })
      .where(eq(draftPatents.draftId, draftId))
      .returning();
    if (!row) return null;
    return { ...row, kind: row.kind as DraftKind };
  },
};

export const searchQuerySetRepo: SearchQuerySetRepository = {
  async findByCaseId(caseId) {
    return db
      .select()
      .from(searchQuerySets)
      .where(eq(searchQuerySets.caseId, caseId))
      .orderBy(desc(searchQuerySets.querySetId));
  },
  async create(data) {
    const [row] = await db.insert(searchQuerySets).values(data).returning();
    return row;
  },
};

export const priorArtDocumentRepo: PriorArtDocumentRepository = {
  async findByCaseId(caseId) {
    return db
      .select()
      .from(priorArtDocuments)
      .where(eq(priorArtDocuments.caseId, caseId))
      .orderBy(desc(priorArtDocuments.docId));
  },
  async createMany(docs) {
    if (docs.length === 0) return 0;
    const inserted = await db.insert(priorArtDocuments).values(docs).returning();
    return inserted.length;
  },
  async upsertManyByPublicationNo(caseId, docs) {
    // 既存の publicationNo → docId マップを構築。publicationNo=null は除外。
    const existing = await db
      .select({
        docId: priorArtDocuments.docId,
        publicationNo: priorArtDocuments.publicationNo,
      })
      .from(priorArtDocuments)
      .where(eq(priorArtDocuments.caseId, caseId));
    const existingMap = new Map<string, number>();
    for (const e of existing) {
      if (e.publicationNo) existingMap.set(e.publicationNo, e.docId);
    }

    const toInsert: typeof docs = [];
    let updated = 0;
    for (const doc of docs) {
      const existingDocId = doc.publicationNo
        ? existingMap.get(doc.publicationNo)
        : undefined;
      if (existingDocId !== undefined) {
        await db
          .update(priorArtDocuments)
          .set({
            title: doc.title,
            abstract: doc.abstract,
            claimsText: doc.claimsText,
            sourceCsvRowJson: doc.sourceCsvRowJson,
            normalizedElementsJson: doc.normalizedElementsJson,
          })
          .where(eq(priorArtDocuments.docId, existingDocId));
        updated++;
      } else {
        toInsert.push(doc);
      }
    }
    let inserted = 0;
    if (toInsert.length > 0) {
      const result = await db
        .insert(priorArtDocuments)
        .values(toInsert)
        .returning();
      inserted = result.length;
    }
    return { inserted, updated };
  },
  async deleteByIds(caseId, docIds) {
    if (docIds.length === 0) return 0;
    // comparison_results.prior_doc_id が priorArtDocuments.docId を外部キー参照しているため、
    // 先に該当 docId を参照する分析結果を削除しないと FK 制約違反になる。
    // confirm ダイアログで「重なり分析の結果も影響を受ける」と警告済み。
    await db
      .delete(comparisonResults)
      .where(
        and(
          eq(comparisonResults.caseId, caseId),
          inArray(comparisonResults.priorDocId, docIds)
        )
      );
    const deleted = await db
      .delete(priorArtDocuments)
      .where(
        and(
          eq(priorArtDocuments.caseId, caseId),
          inArray(priorArtDocuments.docId, docIds)
        )
      )
      .returning();
    return deleted.length;
  },
};

export const comparisonResultRepo: ComparisonResultRepository = {
  async findByCaseId(caseId) {
    return db
      .select()
      .from(comparisonResults)
      .where(eq(comparisonResults.caseId, caseId));
  },
  async replaceByCaseId(caseId, results) {
    await db.delete(comparisonResults).where(eq(comparisonResults.caseId, caseId));
    if (results.length === 0) return 0;
    const inserted = await db.insert(comparisonResults).values(results).returning();
    return inserted.length;
  },
};

export const kohoImportRepo: KohoImportRepository = {
  async savePlan(plan) {
    const validatedPlan = validatedPlanSnapshot(plan);

    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${KOHO_IMPORT_WATCH_CURSOR_LOCK_ID}::bigint)`,
      );
      const [latestCursor] = await tx
        .select({ updatedAt: kohoImportRuns.updatedAt })
        .from(kohoImportRuns)
        .orderBy(
          desc(kohoImportRuns.updatedAt),
          desc(kohoImportRuns.importId),
        )
        .limit(1);
      const nextUpdatedAt = latestCursor
        ? sql<string>`greatest(clock_timestamp(), ${latestCursor.updatedAt}::timestamptz + interval '1 microsecond')`
        : sql<string>`clock_timestamp()`;

      const [runRow] = await tx
        .insert(kohoImportRuns)
        .values({
          packageType: validatedPlan.packageType,
          sourceSha256: validatedPlan.sourceSha256,
          packageStatus: validatedPlan.packageStatus,
          documentCount: validatedPlan.documentCount,
          amendmentCount: validatedPlan.amendmentCount,
          nestedSt26Count: validatedPlan.nestedSt26Count,
          countsJson: validatedPlan.countsJson,
          issuesJson: validatedPlan.issuesJson,
          updatedAt: nextUpdatedAt,
        })
        .onConflictDoUpdate({
          target: [kohoImportRuns.packageType, kohoImportRuns.sourceSha256],
          set: {
            packageStatus: validatedPlan.packageStatus,
            documentCount: validatedPlan.documentCount,
            amendmentCount: validatedPlan.amendmentCount,
            nestedSt26Count: validatedPlan.nestedSt26Count,
            countsJson: validatedPlan.countsJson,
            issuesJson: validatedPlan.issuesJson,
            updatedAt: nextUpdatedAt,
          },
        })
        .returning();

      if (!runRow) {
        throw new Error("Koho import run upsert returned no row");
      }

      await tx
        .delete(kohoImportDocuments)
        .where(eq(kohoImportDocuments.importId, runRow.importId));

      let savedDocumentCount = 0;
      if (validatedPlan.documents.length > 0) {
        const inserted = await tx
          .insert(kohoImportDocuments)
          .values(
            validatedPlan.documents.map((document) => ({
              importId: runRow.importId,
              normalizedEntryPath: document.normalizedEntryPath,
              parseStatus: document.parseStatus,
              kind: document.kind,
              publicationNumber: document.publicationNumber,
              applicationNumber: document.applicationNumber,
              publicationDate: document.publicationDate,
              registrationNumber: document.registrationNumber,
              registrationDate: document.registrationDate,
              inventionTitle: document.inventionTitle,
              abstractText: document.abstractText,
              claimsText: document.claimsText,
              applicantsJson: document.applicantsJson,
              ipcJson: document.ipcJson,
              fiJson: document.fiJson,
              parseIssuesJson: document.parseIssuesJson,
              sourceMetadataJson: document.sourceMetadataJson,
              contentSha256: document.contentSha256,
            })),
          )
          .returning({ documentId: kohoImportDocuments.documentId });
        savedDocumentCount = inserted.length;
      }

      return {
        run: toKohoImportRun(runRow),
        savedDocumentCount,
      };
    });
  },

  async findRunBySource(packageType, sourceSha256) {
    assertPackageType(packageType);
    assertSha256(sourceSha256, "invalid_source_sha256");

    const [row] = await db
      .select()
      .from(kohoImportRuns)
      .where(
        and(
          eq(kohoImportRuns.packageType, packageType),
          eq(kohoImportRuns.sourceSha256, sourceSha256),
        ),
      );
    return row ? toKohoImportRun(row) : null;
  },

  async findDocumentsByRunId(importId) {
    assertImportId(importId);

    const [runRow] = await db
      .select()
      .from(kohoImportRuns)
      .where(eq(kohoImportRuns.importId, importId));
    if (!runRow) return [];
    const run = toKohoImportRun(runRow);

    const rows = await db
      .select()
      .from(kohoImportDocuments)
      .where(eq(kohoImportDocuments.importId, importId))
      .orderBy(
        asc(kohoImportDocuments.normalizedEntryPath),
        asc(kohoImportDocuments.documentId),
      );
    return rows.map((row) => toKohoImportDocument(row, run.packageType));
  },
};

export const patentWatchRepo: PatentWatchRepository = {
  async getSetting(caseId) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      const [row] = await db
        .select({
          caseId: cases.caseId,
          setting: caseWatchSettings,
        })
        .from(cases)
        .leftJoin(
          caseWatchSettings,
          eq(caseWatchSettings.caseId, cases.caseId),
        )
        .where(eq(cases.caseId, caseId))
        .limit(1);
      if (!row) patentWatchError("case_not_found");
      return row.setting === null ? null : toCaseWatchSetting(row.setting);
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async upsertSetting(caseId, data) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      if (
        typeof data.enabled !== "boolean" ||
        !isValidYyyyMmDd(data.monitoringFromDate)
      ) {
        patentWatchError("invalid_watch_setting");
      }

      return await db.transaction(async (tx) => {
        const [caseRow] = await tx
          .select({ caseId: cases.caseId })
          .from(cases)
          .where(eq(cases.caseId, caseId))
          .for("update");
        if (!caseRow) patentWatchError("case_not_found");

        const [settingRow] = await tx
          .insert(caseWatchSettings)
          .values({
            caseId,
            enabled: data.enabled,
            monitoringFromDate: data.monitoringFromDate,
          })
          .onConflictDoUpdate({
            target: caseWatchSettings.caseId,
            set: {
              enabled: data.enabled,
              monitoringFromDate: data.monitoringFromDate,
              updatedAt: sql`now()`,
            },
          })
          .returning();
        if (!settingRow) patentWatchError("watch_unavailable");
        return toCaseWatchSetting(settingRow);
      });
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async startRun(caseId) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      return await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(${KOHO_IMPORT_WATCH_CURSOR_LOCK_ID}::bigint)`,
        );
        const [caseRow] = await tx
          .select({ caseId: cases.caseId })
          .from(cases)
          .where(eq(cases.caseId, caseId))
          .for("update");
        if (!caseRow) patentWatchError("case_not_found");

        const [settingRow] = await tx
          .select()
          .from(caseWatchSettings)
          .where(eq(caseWatchSettings.caseId, caseId))
          .for("update");
        if (!settingRow) patentWatchError("watch_not_configured");
        const setting = toCaseWatchSetting(settingRow);
        if (!setting.enabled) patentWatchError("watch_disabled");

        const [runningRow] = await tx
          .select({ runId: caseWatchRuns.runId })
          .from(caseWatchRuns)
          .where(
            and(
              eq(caseWatchRuns.watchId, setting.watchId),
              eq(caseWatchRuns.status, "running"),
            ),
          )
          .limit(1);
        if (runningRow) patentWatchError("watch_run_in_progress");

        const [draftRow] = await tx
          .select({ extractedClaimsJson: draftPatents.extractedClaimsJson })
          .from(draftPatents)
          .where(
            and(
              eq(draftPatents.caseId, caseId),
              eq(draftPatents.kind, "main"),
            ),
          )
          .orderBy(desc(draftPatents.draftId))
          .limit(1);
        if (!draftRow?.extractedClaimsJson?.trim()) {
          patentWatchError("watch_claims_not_ready");
        }

        let upperRow:
          | { updatedAt: string; importId: number }
          | undefined;
        try {
          [upperRow] = await tx
            .select({
              updatedAt: kohoImportRuns.updatedAt,
              importId: kohoImportRuns.importId,
            })
            .from(kohoImportRuns)
            .orderBy(
              desc(kohoImportRuns.updatedAt),
              desc(kohoImportRuns.importId),
            )
            .limit(1);
        } catch {
          patentWatchError("watch_corpus_unavailable");
        }

        const baseCursor = toPatentWatchCursor(
          setting.cursorRunUpdatedAt,
          setting.cursorImportId,
          "watch_unavailable",
        );
        const upperCursor = upperRow
          ? toPatentWatchCursor(
              upperRow.updatedAt,
              upperRow.importId,
              "watch_corpus_unavailable",
            )
          : null;
        if (
          baseCursor !== null &&
          (upperCursor === null ||
            comparePatentWatchCursor(upperCursor, baseCursor) < 0)
        ) {
          patentWatchError("watch_corpus_unavailable");
        }

        const [runRow] = await tx.insert(caseWatchRuns).values({
          watchId: setting.watchId,
          status: "running",
          monitoringFromDate: setting.monitoringFromDate,
          baseCursorRunUpdatedAt: baseCursor?.runUpdatedAt ?? null,
          baseCursorImportId: baseCursor?.importId ?? null,
          upperCursorRunUpdatedAt: upperCursor?.runUpdatedAt ?? null,
          upperCursorImportId: upperCursor?.importId ?? null,
        }).returning();
        if (!runRow) patentWatchError("watch_unavailable");

        return {
          caseId,
          watchId: setting.watchId,
          runId: runRow.runId,
          monitoringFromDate: setting.monitoringFromDate,
          baseCursor,
          upperCursor,
          extractedClaimsJson: draftRow.extractedClaimsJson,
        };
      });
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async findDocumentsForRun(runId) {
    assertPatentWatchId(runId, "watch_run_not_found");

    let context:
      | {
          run: typeof caseWatchRuns.$inferSelect;
          setting: typeof caseWatchSettings.$inferSelect;
        }
      | undefined;
    try {
      [context] = await db
        .select({ run: caseWatchRuns, setting: caseWatchSettings })
        .from(caseWatchRuns)
        .innerJoin(
          caseWatchSettings,
          eq(caseWatchSettings.watchId, caseWatchRuns.watchId),
        )
        .where(eq(caseWatchRuns.runId, runId))
        .limit(1);
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
    if (!context) {
      patentWatchError("watch_run_not_found");
    }
    const run = toCaseWatchRun(context.run);
    if (run.status !== "running") {
      patentWatchError("watch_run_not_found");
    }
    const baseCursor = toPatentWatchCursor(
      context.run.baseCursorRunUpdatedAt,
      context.run.baseCursorImportId,
      "watch_unavailable",
    );
    const upperCursor = toPatentWatchCursor(
      context.run.upperCursorRunUpdatedAt,
      context.run.upperCursorImportId,
      "watch_unavailable",
    );
    if (upperCursor === null) {
      return {
        documents: [],
        scannedImportRunCount: 0,
        scannedDocumentCount: 0,
      };
    }

    const afterBase =
      baseCursor === null
        ? undefined
        : or(
            gt(kohoImportRuns.updatedAt, baseCursor.runUpdatedAt),
            and(
              eq(kohoImportRuns.updatedAt, baseCursor.runUpdatedAt),
              gt(kohoImportRuns.importId, baseCursor.importId),
            ),
          );
    const throughUpper = or(
      lt(kohoImportRuns.updatedAt, upperCursor.runUpdatedAt),
      and(
        eq(kohoImportRuns.updatedAt, upperCursor.runUpdatedAt),
        lte(kohoImportRuns.importId, upperCursor.importId),
      ),
    );

    try {
      const rows = await db
        .select({ run: kohoImportRuns, document: kohoImportDocuments })
        .from(kohoImportRuns)
        .leftJoin(
          kohoImportDocuments,
          baseCursor === null
            ? and(
                eq(kohoImportDocuments.importId, kohoImportRuns.importId),
                gte(
                  sql<string>`replace(${kohoImportDocuments.publicationDate}, '-', '')`,
                  run.monitoringFromDate,
                ),
              )
            : eq(kohoImportDocuments.importId, kohoImportRuns.importId),
        )
        .where(
          afterBase === undefined
            ? throughUpper
            : and(afterBase, throughUpper),
        )
        .orderBy(
          asc(kohoImportRuns.updatedAt),
          asc(kohoImportRuns.importId),
          asc(kohoImportDocuments.documentId),
        );

      const importIds = new Set<number>();
      const documents: PatentWatchCorpusDocument[] = [];
      for (const row of rows) {
        importIds.add(row.run.importId);
        if (row.document === null) continue;
        const document = toKohoCorpusSourceDocument(row.document, row.run);
        documents.push({
          documentId: document.documentId,
          importId: document.importId,
          importRunUpdatedAt: row.run.updatedAt,
          packageType: document.packageType,
          kind: document.kind,
          publicationNumber: document.publicationNumber,
          publicationDate: document.publicationDate,
          inventionTitle: document.inventionTitle,
          abstractText: document.abstractText,
          claimsText: document.claimsText,
          contentSha256: document.contentSha256,
        });
      }
      return {
        documents,
        scannedImportRunCount: importIds.size,
        scannedDocumentCount: documents.length,
      };
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_corpus_unavailable");
    }
  },

  async findExistingSourceKeys(watchId, sourceKeys) {
    try {
      assertPatentWatchId(watchId, "watch_not_configured");
      const uniqueSourceKeys = Array.from(new Set(sourceKeys));
      if (uniqueSourceKeys.some((sourceKey) => !SHA256_PATTERN.test(sourceKey))) {
        patentWatchError("watch_internal_error");
      }
      if (uniqueSourceKeys.length === 0) return [];

      const found = new Set<string>();
      for (
        let offset = 0;
        offset < uniqueSourceKeys.length;
        offset += PATENT_WATCH_SOURCE_KEY_BATCH_SIZE
      ) {
        const sourceKeyBatch = uniqueSourceKeys.slice(
          offset,
          offset + PATENT_WATCH_SOURCE_KEY_BATCH_SIZE,
        );
        const rows = await db
          .select({ sourceKey: caseWatchFindings.sourceKey })
          .from(caseWatchFindings)
          .where(
            and(
              eq(caseWatchFindings.watchId, watchId),
              inArray(caseWatchFindings.sourceKey, sourceKeyBatch),
            ),
          )
          .orderBy(asc(caseWatchFindings.sourceKey));
        for (const row of rows) found.add(row.sourceKey);
      }
      return Array.from(found).sort();
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async finalizeRunSuccess(input) {
    try {
      assertPatentWatchId(input.caseId, "case_not_found");
      assertPatentWatchId(input.runId, "watch_run_not_found");
      for (const count of Object.values(input.counts)) {
        if (!Number.isSafeInteger(count) || count < 0) {
          patentWatchError("watch_internal_error");
        }
      }
      if (!PATENT_WATCH_ANALYSIS_MODES.has(input.analysisMode)) {
        patentWatchError("watch_internal_error");
      }
      input.findings.forEach(assertPatentWatchFindingInsert);

      return await db.transaction(async (tx) => {
        const [context] = await tx
          .select({ run: caseWatchRuns, setting: caseWatchSettings })
          .from(caseWatchRuns)
          .innerJoin(
            caseWatchSettings,
            eq(caseWatchSettings.watchId, caseWatchRuns.watchId),
          )
          .where(
            and(
              eq(caseWatchRuns.runId, input.runId),
              eq(caseWatchSettings.caseId, input.caseId),
            ),
          )
          .for("update");
        if (!context || toCaseWatchRun(context.run).status !== "running") {
          patentWatchError("watch_run_not_found");
        }

        const insertedRows =
          input.findings.length === 0
            ? []
            : await tx
                .insert(caseWatchFindings)
                .values(
                  input.findings.map((finding) => ({
                    watchId: context.setting.watchId,
                    firstRunId: context.run.runId,
                    sourceKey: finding.sourceKey,
                    corpusDocumentId: finding.corpusDocumentId,
                    packageType: finding.packageType,
                    kind: finding.kind,
                    publicationNumber: finding.publicationNumber,
                    publicationDate: finding.publicationDate,
                    inventionTitle: finding.inventionTitle,
                    abstractPreview: finding.abstractPreview,
                    lexicalScore: finding.lexicalScore,
                    elementScore: finding.elementScore,
                    semanticScore: finding.semanticScore,
                    structuralScore: finding.structuralScore,
                    riskLabel: finding.riskLabel,
                    analysisJson: finding.analysisJson,
                    analysisMode: finding.analysisMode,
                    reviewStatus: "unreviewed",
                  })),
                )
                .onConflictDoNothing({
                  target: [
                    caseWatchFindings.watchId,
                    caseWatchFindings.sourceKey,
                  ],
                })
                .returning({ analysisMode: caseWatchFindings.analysisMode });
        const fallbackFindingCount = insertedRows.filter(
          (row) => row.analysisMode === "fallback",
        ).length;

        const [completedRun] = await tx
          .update(caseWatchRuns)
          .set({
            status: "completed",
            completedAt: sql`now()`,
            scannedImportRunCount: input.counts.scannedImportRunCount,
            scannedDocumentCount: input.counts.scannedDocumentCount,
            prefilteredCount: input.counts.prefilteredCount,
            analyzedCount: input.counts.analyzedCount,
            newFindingCount: insertedRows.length,
            fallbackFindingCount,
            analysisMode: input.analysisMode,
            errorCode: null,
          })
          .where(
            and(
              eq(caseWatchRuns.runId, input.runId),
              eq(caseWatchRuns.status, "running"),
            ),
          )
          .returning();
        if (!completedRun) patentWatchError("watch_run_not_found");

        const [updatedSetting] = await tx
          .update(caseWatchSettings)
          .set({
            cursorRunUpdatedAt: context.run.upperCursorRunUpdatedAt,
            cursorImportId: context.run.upperCursorImportId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(caseWatchSettings.watchId, context.setting.watchId),
              eq(caseWatchSettings.caseId, input.caseId),
            ),
          )
          .returning({ watchId: caseWatchSettings.watchId });
        if (!updatedSetting) patentWatchError("watch_unavailable");

        return toCaseWatchRun(completedRun);
      });
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async finalizeRunFailure(input) {
    try {
      assertPatentWatchId(input.caseId, "case_not_found");
      assertPatentWatchId(input.runId, "watch_run_not_found");
      if (!PATENT_WATCH_ERROR_CODES.has(input.errorCode)) {
        patentWatchError("watch_internal_error");
      }

      return await db.transaction(async (tx) => {
        const [context] = await tx
          .select({ run: caseWatchRuns, setting: caseWatchSettings })
          .from(caseWatchRuns)
          .innerJoin(
            caseWatchSettings,
            eq(caseWatchSettings.watchId, caseWatchRuns.watchId),
          )
          .where(
            and(
              eq(caseWatchRuns.runId, input.runId),
              eq(caseWatchSettings.caseId, input.caseId),
            ),
          )
          .for("update");
        if (!context || toCaseWatchRun(context.run).status !== "running") {
          patentWatchError("watch_run_not_found");
        }

        const [failedRun] = await tx
          .update(caseWatchRuns)
          .set({
            status: "failed",
            completedAt: sql`now()`,
            errorCode: input.errorCode,
          })
          .where(
            and(
              eq(caseWatchRuns.runId, input.runId),
              eq(caseWatchRuns.status, "running"),
            ),
          )
          .returning();
        if (!failedRun) patentWatchError("watch_run_not_found");
        return toCaseWatchRun(failedRun);
      });
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async getRun(caseId, runId) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      assertPatentWatchId(runId, "watch_run_not_found");
      const [row] = await db
        .select({ run: caseWatchRuns })
        .from(caseWatchRuns)
        .innerJoin(
          caseWatchSettings,
          eq(caseWatchSettings.watchId, caseWatchRuns.watchId),
        )
        .where(
          and(
            eq(caseWatchSettings.caseId, caseId),
            eq(caseWatchRuns.runId, runId),
          ),
        )
        .limit(1);
      return row ? toCaseWatchRun(row.run) : null;
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async listRuns(caseId, limit) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      limit = normalizePatentWatchListLimit(limit);
      const rows = await db
        .select({ run: caseWatchRuns })
        .from(caseWatchRuns)
        .innerJoin(
          caseWatchSettings,
          eq(caseWatchSettings.watchId, caseWatchRuns.watchId),
        )
        .where(eq(caseWatchSettings.caseId, caseId))
        .orderBy(
          desc(caseWatchRuns.startedAt),
          desc(caseWatchRuns.runId),
        )
        .limit(limit);
      return rows.map((row) => toCaseWatchRun(row.run));
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async listFindings(caseId, options) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      const limit = normalizePatentWatchListLimit(options.limit);
      if (options.runId !== undefined) {
        assertPatentWatchId(options.runId, "watch_run_not_found");
      }
      const rows = await db
        .select({ finding: caseWatchFindings })
        .from(caseWatchFindings)
        .innerJoin(
          caseWatchSettings,
          eq(caseWatchSettings.watchId, caseWatchFindings.watchId),
        )
        .where(
          and(
            eq(caseWatchSettings.caseId, caseId),
            options.runId === undefined
              ? undefined
              : eq(caseWatchFindings.firstRunId, options.runId),
          ),
        )
        .orderBy(
          desc(caseWatchFindings.firstSeenAt),
          desc(caseWatchFindings.findingId),
        )
        .limit(limit);
      return rows.map((row) => toCaseWatchFinding(row.finding));
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async countUnreviewedFindings(caseId) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      const [row] = await db
        .select({ count: sql<number>`count(*)::integer` })
        .from(caseWatchFindings)
        .innerJoin(
          caseWatchSettings,
          eq(caseWatchSettings.watchId, caseWatchFindings.watchId),
        )
        .where(
          and(
            eq(caseWatchSettings.caseId, caseId),
            eq(caseWatchFindings.reviewStatus, "unreviewed"),
          ),
        );
      const count = Number(row?.count ?? 0);
      assertPatentWatchCount(count);
      return count;
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },

  async updateFindingReviewStatus(caseId, findingId, reviewStatus) {
    try {
      assertPatentWatchId(caseId, "case_not_found");
      assertPatentWatchId(findingId, "watch_finding_not_found");
      if (!PATENT_WATCH_REVIEW_STATUSES.has(reviewStatus)) {
        patentWatchError("watch_internal_error");
      }

      return await db.transaction(async (tx) => {
        const [ownedFinding] = await tx
          .select({ finding: caseWatchFindings })
          .from(caseWatchFindings)
          .innerJoin(
            caseWatchSettings,
            eq(caseWatchSettings.watchId, caseWatchFindings.watchId),
          )
          .where(
            and(
              eq(caseWatchSettings.caseId, caseId),
              eq(caseWatchFindings.findingId, findingId),
            ),
          )
          .for("update");
        if (!ownedFinding) return null;

        const [updated] = await tx
          .update(caseWatchFindings)
          .set({ reviewStatus })
          .where(
            and(
              eq(caseWatchFindings.watchId, ownedFinding.finding.watchId),
              eq(caseWatchFindings.findingId, findingId),
            ),
          )
          .returning();
        if (!updated) patentWatchError("watch_finding_not_found");
        return toCaseWatchFinding(updated);
      });
    } catch (error) {
      rethrowPatentWatchRepositoryError(error, "watch_unavailable");
    }
  },
};

export const kohoCorpusRepo: KohoCorpusRepository = {
  async searchForCase(caseId, query, limit) {
    try {
      if (
        !Number.isSafeInteger(caseId) ||
        caseId < 1 ||
        caseId > POSTGRES_INTEGER_MAX
      ) {
        throw new KohoCorpusDomainError("case_not_found");
      }
      const [caseRow] = await db
        .select({ caseId: cases.caseId })
        .from(cases)
        .where(eq(cases.caseId, caseId))
        .limit(1);
      if (!caseRow) {
        throw new KohoCorpusDomainError("case_not_found");
      }

      const rows = await db
        .select({
          document: kohoImportDocuments,
          run: kohoImportRuns,
        })
        .from(kohoImportDocuments)
        .innerJoin(
          kohoImportRuns,
          eq(kohoImportDocuments.importId, kohoImportRuns.importId),
        )
        .where(
          or(
            sql<boolean>`strpos(lower(${kohoImportDocuments.publicationNumber}), lower(cast(${query} as text))) > 0`,
            sql<boolean>`strpos(lower(${kohoImportDocuments.applicationNumber}), lower(cast(${query} as text))) > 0`,
            sql<boolean>`strpos(lower(${kohoImportDocuments.inventionTitle}), lower(cast(${query} as text))) > 0`,
          ),
        )
        .orderBy(
          desc(kohoImportDocuments.publicationDate),
          asc(kohoImportDocuments.publicationNumber),
          asc(kohoImportDocuments.documentId),
        )
        .limit(limit);

      return rows.map(({ document, run }) =>
        toKohoCorpusSearchSummary(
          toKohoCorpusSourceDocument(document, run),
        ),
      );
    } catch (error) {
      rethrowKohoCorpusError(error);
    }
  },

  async attachToCase(caseId, documentIds) {
    try {
      if (
        !Number.isSafeInteger(caseId) ||
        caseId < 1 ||
        caseId > POSTGRES_INTEGER_MAX
      ) {
        throw new KohoCorpusDomainError("case_not_found");
      }
      return await db.transaction(async (tx) => {
        const [caseRow] = await tx
          .select({ caseId: cases.caseId })
          .from(cases)
          .where(eq(cases.caseId, caseId))
          .for("update");
        if (!caseRow) {
          throw new KohoCorpusDomainError("case_not_found");
        }
        if (
          documentIds.some(
            (documentId) =>
              !Number.isSafeInteger(documentId) ||
              documentId < 1 ||
              documentId > POSTGRES_INTEGER_MAX,
          )
        ) {
          throw new KohoCorpusDomainError("koho_document_not_found");
        }

        const selectedRows =
          documentIds.length === 0
            ? []
            : await tx
                .select({
                  document: kohoImportDocuments,
                  run: kohoImportRuns,
                })
                .from(kohoImportDocuments)
                .innerJoin(
                  kohoImportRuns,
                  eq(kohoImportDocuments.importId, kohoImportRuns.importId),
                )
                .where(inArray(kohoImportDocuments.documentId, documentIds));
        const sourceDocuments = selectedRows.map(({ document, run }) =>
          toKohoCorpusSourceDocument(document, run),
        );

        const selectionPlan = buildKohoCorpusAttachPlan({
          caseId,
          documentIds,
          documents: sourceDocuments,
          existingDocuments: [],
        });
        const selectedPublicationNumbers = selectionPlan.inserted.map(
          ({ snapshot }) => snapshot.publicationNo,
        );

        const existingDocuments = await tx
          .select()
          .from(priorArtDocuments)
          .where(
            and(
              eq(priorArtDocuments.caseId, caseId),
              inArray(
                priorArtDocuments.publicationNo,
                selectedPublicationNumbers,
              ),
            ),
          )
          .orderBy(asc(priorArtDocuments.docId))
          .for("update");
        assertNoDuplicateExistingPublicationNumbers(existingDocuments);

        const plan = buildKohoCorpusAttachPlan({
          caseId,
          documentIds,
          documents: sourceDocuments,
          existingDocuments,
        });

        if (plan.inserted.length > 0) {
          const inserted = await tx
            .insert(priorArtDocuments)
            .values(plan.inserted.map(({ snapshot }) => snapshot))
            .returning({ docId: priorArtDocuments.docId });
          if (inserted.length !== plan.inserted.length) {
            throw unavailableKohoCorpus();
          }
        }

        for (const operation of plan.updated) {
          const [updated] = await tx
            .update(priorArtDocuments)
            .set(operation.snapshot)
            .where(
              and(
                eq(priorArtDocuments.caseId, caseId),
                eq(priorArtDocuments.docId, operation.docId),
              ),
            )
            .returning({ docId: priorArtDocuments.docId });
          if (!updated) {
            throw unavailableKohoCorpus();
          }
        }

        if (plan.analysisCleared) {
          await tx
            .delete(comparisonResults)
            .where(eq(comparisonResults.caseId, caseId));
        }

        return {
          selected: plan.selected,
          inserted: plan.inserted.length,
          updated: plan.updated.length,
          unchanged: plan.unchanged.length,
          analysisCleared: plan.analysisCleared,
        };
      });
    } catch (error) {
      rethrowKohoCorpusError(error);
    }
  },
};
