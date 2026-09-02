import { buildPatentWatchReportCsv } from "./csv";
import {
  boundedPatentWatchPublicText,
  PatentWatchDomainError,
  isPatentWatchErrorCode,
  isValidPatentWatchTimestamp,
  isValidPatentWatchDate,
  parsePatentWatchCursor,
  sanitizePatentWatchAnalysis,
  stablePatentWatchErrorCode,
  validatePatentWatchReviewInput,
  validatePatentWatchSettingInput,
} from "./domain";
import type {
  CaseWatchFinding,
  CaseWatchRun,
  CaseWatchSetting,
  PatentWatchAnalysisJson,
  PatentWatchReviewStatus,
  PatentWatchSettingInput,
} from "./types";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const RUN_HISTORY_LIMIT = 20;
const FINDING_LIST_LIMIT = 100;

const RUN_STATUSES = new Set(["running", "completed", "failed"]);
const ANALYSIS_MODES = new Set(["none", "ai", "fallback"]);
const FINDING_ANALYSIS_MODES = new Set(["ai", "fallback"]);
const REVIEW_STATUSES = new Set(["unreviewed", "reviewed"]);
const PACKAGE_TYPES = new Set(["JPA", "JPB"]);
const DOCUMENT_KINDS = new Set(["A1", "P1", "B1", "B2"]);
const RISK_LABELS = new Set(["High", "Medium", "Low", "Unknown"]);

export interface PatentWatchApiRepository {
  getSetting(caseId: number): Promise<CaseWatchSetting | null>;
  upsertSetting(
    caseId: number,
    data: PatentWatchSettingInput,
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
    reviewStatus: PatentWatchReviewStatus,
  ): Promise<CaseWatchFinding | null>;
}

export interface PatentWatchRouteContext {
  params: Promise<{ caseId: string }>;
}

export interface PatentWatchFindingRouteContext {
  params: Promise<{ caseId: string; findingId: string }>;
}

export interface PatentWatchRunHandlerDependencies {
  executeRun(caseId: number): Promise<CaseWatchRun>;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function unavailable(): never {
  throw new PatentWatchDomainError("watch_unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= POSTGRES_INTEGER_MAX
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseRouteId(value: string, errorCode: "case_not_found" | "watch_finding_not_found"): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new PatentWatchDomainError(errorCode);
  }
  const result = Number(value);
  if (!isPositiveInteger(result)) {
    throw new PatentWatchDomainError(errorCode);
  }
  return result;
}

function parseCaseId(value: string): number {
  return parseRouteId(value, "case_not_found");
}

function parseFindingId(value: string): number {
  return parseRouteId(value, "watch_finding_not_found");
}

function parseRunId(searchParams: URLSearchParams): number {
  const entries = Array.from(searchParams.entries());
  if (
    entries.length !== 1 ||
    entries[0][0] !== "runId" ||
    !/^[1-9][0-9]*$/.test(entries[0][1])
  ) {
    throw new PatentWatchDomainError("watch_run_not_found");
  }
  const runId = Number(entries[0][1]);
  if (!isPositiveInteger(runId)) {
    throw new PatentWatchDomainError("watch_run_not_found");
  }
  return runId;
}

function isTimestamp(value: unknown): value is string {
  return isValidPatentWatchTimestamp(value);
}

function publicText(value: unknown, maxCharacters: number): string {
  if (typeof value !== "string") unavailable();
  return boundedPatentWatchPublicText(value, maxCharacters);
}

function nullablePublicText(
  value: unknown,
  maxCharacters: number,
): string | null {
  return value === null ? null : publicText(value, maxCharacters);
}

function score(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    unavailable();
  }
  return value;
}

function parseAnalysis(value: unknown): PatentWatchAnalysisJson {
  if (typeof value !== "string") unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    unavailable();
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.matchedElements) ||
    !parsed.matchedElements.every((item) => typeof item === "string") ||
    !Array.isArray(parsed.unmatchedElements) ||
    !parsed.unmatchedElements.every((item) => typeof item === "string") ||
    typeof parsed.explanation !== "string"
  ) {
    unavailable();
  }
  return sanitizePatentWatchAnalysis({
    matchedElements: parsed.matchedElements,
    unmatchedElements: parsed.unmatchedElements,
    explanation: parsed.explanation,
  });
}

function projectSetting(value: unknown, expectedCaseId: number) {
  if (!isRecord(value)) unavailable();
  if (
    !isPositiveInteger(value.watchId) ||
    value.caseId !== expectedCaseId ||
    typeof value.enabled !== "boolean" ||
    !isValidPatentWatchDate(value.monitoringFromDate) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt)
  ) {
    unavailable();
  }
  parsePatentWatchCursor(value.cursorRunUpdatedAt, value.cursorImportId);
  return {
    watchId: value.watchId,
    enabled: value.enabled,
    monitoringFromDate: value.monitoringFromDate,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function projectRun(value: unknown, expected?: { runId?: number; watchId?: number }) {
  if (!isRecord(value)) unavailable();
  if (
    !isPositiveInteger(value.runId) ||
    !isPositiveInteger(value.watchId) ||
    (expected?.runId !== undefined && value.runId !== expected.runId) ||
    (expected?.watchId !== undefined && value.watchId !== expected.watchId) ||
    !RUN_STATUSES.has(value.status as string) ||
    !isValidPatentWatchDate(value.monitoringFromDate) ||
    !isTimestamp(value.startedAt) ||
    (value.completedAt !== null && !isTimestamp(value.completedAt)) ||
    !isNonNegativeInteger(value.scannedImportRunCount) ||
    !isNonNegativeInteger(value.scannedDocumentCount) ||
    !isNonNegativeInteger(value.prefilteredCount) ||
    !isNonNegativeInteger(value.analyzedCount) ||
    !isNonNegativeInteger(value.newFindingCount) ||
    !isNonNegativeInteger(value.fallbackFindingCount) ||
    !ANALYSIS_MODES.has(value.analysisMode as string) ||
    (value.errorCode !== null && !isPatentWatchErrorCode(value.errorCode))
  ) {
    unavailable();
  }
  parsePatentWatchCursor(value.baseRunUpdatedAt, value.baseImportId);
  parsePatentWatchCursor(value.upperRunUpdatedAt, value.upperImportId);
  return {
    runId: value.runId,
    status: value.status,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    scannedImportRunCount: value.scannedImportRunCount,
    scannedDocumentCount: value.scannedDocumentCount,
    prefilteredCount: value.prefilteredCount,
    analyzedCount: value.analyzedCount,
    newFindingCount: value.newFindingCount,
    fallbackFindingCount: value.fallbackFindingCount,
    analysisMode: value.analysisMode,
    errorCode: value.errorCode,
  };
}

function projectFinding(value: unknown, expectedWatchId?: number) {
  if (!isRecord(value)) unavailable();
  if (
    !isPositiveInteger(value.findingId) ||
    !isPositiveInteger(value.watchId) ||
    (expectedWatchId !== undefined && value.watchId !== expectedWatchId) ||
    !isPositiveInteger(value.firstRunId) ||
    !PACKAGE_TYPES.has(value.packageType as string) ||
    !DOCUMENT_KINDS.has(value.kind as string) ||
    !isValidPatentWatchDate(value.publicationDate) ||
    !RISK_LABELS.has(value.riskLabel as string) ||
    !FINDING_ANALYSIS_MODES.has(value.analysisMode as string) ||
    !REVIEW_STATUSES.has(value.reviewStatus as string) ||
    !isTimestamp(value.firstSeenAt)
  ) {
    unavailable();
  }
  const analysis = parseAnalysis(value.analysisJson);
  return {
    findingId: value.findingId,
    firstRunId: value.firstRunId,
    packageType: value.packageType,
    kind: value.kind,
    publicationNumber: publicText(value.publicationNumber, 100),
    publicationDate: value.publicationDate,
    inventionTitle: publicText(value.inventionTitle, 500),
    abstractPreview: nullablePublicText(value.abstractPreview, 300),
    lexicalScore: score(value.lexicalScore),
    elementScore: score(value.elementScore),
    semanticScore: score(value.semanticScore),
    structuralScore: score(value.structuralScore),
    riskLabel: value.riskLabel,
    matchedElements: analysis.matchedElements,
    unmatchedElements: analysis.unmatchedElements,
    explanation: analysis.explanation,
    analysisMode: value.analysisMode,
    reviewStatus: value.reviewStatus,
    firstSeenAt: value.firstSeenAt,
  };
}

function errorResponse(error: unknown): Response {
  const code = stablePatentWatchErrorCode(error);
  switch (code) {
    case "invalid_watch_setting":
    case "invalid_watch_review_status":
    case "invalid_watch_run_request":
      return jsonResponse({ error: code }, 400);
    case "case_not_found":
    case "watch_run_not_found":
    case "watch_finding_not_found":
      return jsonResponse({ error: code }, 404);
    case "watch_not_configured":
    case "watch_disabled":
    case "watch_claims_not_ready":
    case "watch_run_in_progress":
      return jsonResponse({ error: code }, 409);
    case "watch_corpus_unavailable":
    case "watch_unavailable":
      return jsonResponse({ error: code }, 503);
    case "watch_analysis_failed":
    case "watch_internal_error":
      return jsonResponse({ error: code }, 500);
  }
}

async function requestJson(
  request: Request,
  invalidCode: "invalid_watch_setting" | "invalid_watch_review_status",
): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new PatentWatchDomainError(invalidCode);
  }
}

async function assertEmptyRunRequestBody(request: Request): Promise<void> {
  if (request.body === null) return;
  const reader = request.body.getReader();
  try {
    const firstChunk = await reader.read();
    if (!firstChunk.done) {
      throw new PatentWatchDomainError("invalid_watch_run_request");
    }
  } catch (error) {
    if (error instanceof PatentWatchDomainError) throw error;
    throw new PatentWatchDomainError("invalid_watch_run_request");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createPatentWatchHandlers(dependencies: {
  repository: PatentWatchApiRepository;
}) {
  return {
    async GET(
      _request: Request,
      context: PatentWatchRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        const rawSetting = await dependencies.repository.getSetting(caseId);
        if (rawSetting === null) {
          return jsonResponse({
            setting: null,
            latestRun: null,
            unreviewedFindingCount: 0,
            runs: [],
            findings: [],
          });
        }
        const setting = projectSetting(rawSetting, caseId);
        const [rawRuns, rawFindings, unreviewedFindingCount] =
          await Promise.all([
            dependencies.repository.listRuns(caseId, RUN_HISTORY_LIMIT),
            dependencies.repository.listFindings(caseId, {
              limit: FINDING_LIST_LIMIT,
            }),
            dependencies.repository.countUnreviewedFindings(caseId),
          ]);
        if (
          !Array.isArray(rawRuns) ||
          rawRuns.length > RUN_HISTORY_LIMIT ||
          !Array.isArray(rawFindings) ||
          rawFindings.length > FINDING_LIST_LIMIT ||
          !isNonNegativeInteger(unreviewedFindingCount)
        ) {
          unavailable();
        }
        const runs = rawRuns.map((item) =>
          projectRun(item, { watchId: setting.watchId }),
        );
        const findings = rawFindings.map((item) =>
          projectFinding(item, setting.watchId),
        );
        return jsonResponse({
          setting,
          latestRun: runs[0] ?? null,
          unreviewedFindingCount,
          runs,
          findings,
        });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async PUT(
      request: Request,
      context: PatentWatchRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        const body = await requestJson(request, "invalid_watch_setting");
        const input = validatePatentWatchSettingInput(body);
        const saved = await dependencies.repository.upsertSetting(
          caseId,
          input,
        );
        return jsonResponse(projectSetting(saved, caseId));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createPatentWatchRunHandlers(
  dependencies: PatentWatchRunHandlerDependencies,
) {
  return {
    async POST(
      request: Request,
      context: PatentWatchRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        await assertEmptyRunRequestBody(request);
        const completedRun = await dependencies.executeRun(caseId);
        return jsonResponse(projectRun(completedRun));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createPatentWatchFindingHandlers(dependencies: {
  repository: PatentWatchApiRepository;
}) {
  return {
    async PATCH(
      request: Request,
      context: PatentWatchFindingRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText, findingId: findingIdText } =
          await context.params;
        const caseId = parseCaseId(caseIdText);
        const findingId = parseFindingId(findingIdText);
        const body = await requestJson(
          request,
          "invalid_watch_review_status",
        );
        const { reviewStatus } = validatePatentWatchReviewInput(body);
        const updated =
          await dependencies.repository.updateFindingReviewStatus(
            caseId,
            findingId,
            reviewStatus,
          );
        if (updated === null) {
          throw new PatentWatchDomainError("watch_finding_not_found");
        }
        return jsonResponse(projectFinding(updated));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export function createPatentWatchCsvHandlers(dependencies: {
  repository: PatentWatchApiRepository;
}) {
  return {
    async GET(
      request: Request,
      context: PatentWatchRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        const runId = parseRunId(new URL(request.url).searchParams);
        const rawRun = await dependencies.repository.getRun(caseId, runId);
        if (rawRun === null) {
          throw new PatentWatchDomainError("watch_run_not_found");
        }
        projectRun(rawRun, { runId });
        const findings = await dependencies.repository.listFindings(caseId, {
          runId,
          limit: FINDING_LIST_LIMIT,
        });
        if (!Array.isArray(findings) || findings.length > FINDING_LIST_LIMIT) {
          unavailable();
        }
        const csv = buildPatentWatchReportCsv(findings);
        return new Response(csv, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-disposition":
              `attachment; filename="patent-watch-case-${caseId}-run-${runId}.csv"`,
            "content-type": "text/csv; charset=utf-8",
          },
        });
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
