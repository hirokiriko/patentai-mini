import type { ComparisonResult } from "../analyze-overlap";
import {
  extractedClaimsSchema,
  type ExtractedClaims,
} from "../extract-claims";
import {
  boundedPatentWatchPublicText,
  comparePatentWatchCursors,
  createPatentWatchSourceKey,
  isPositiveSafeInteger,
  isValidPatentWatchDate,
  parsePatentWatchCursor,
  PatentWatchDomainError,
  serializePatentWatchAnalysis,
  stablePatentWatchErrorCode,
} from "./domain";
import {
  prefilterPatentWatchDocuments,
  type PatentWatchPrefilterCandidate,
} from "./prefilter";
import type {
  CaseWatchRun,
  PatentWatchAnalysisDependencies,
  PatentWatchAnalysisMode,
  PatentWatchCorpusBatch,
  PatentWatchCorpusDocument,
  PatentWatchErrorCode,
  PatentWatchFindingInsert,
  PatentWatchRiskLabel,
  PatentWatchRunCounts,
  PatentWatchRunStart,
} from "./types";

const MAX_SCREENING_CANDIDATES = 100;
const MAX_ANALYSIS_CANDIDATES = 20;
const ABSTRACT_PREVIEW_LENGTH = 300;
const SAFE_AI_EXPLANATION =
  "重なり候補を整理した結果です。人による確認が必要です";

export const PATENT_WATCH_FALLBACK_EXPLANATION =
  "AI分析が利用できなかったため、語彙重なりによる確認候補です。人による確認が必要です";

const RISK_LABELS = new Set<PatentWatchRiskLabel>([
  "High",
  "Medium",
  "Low",
  "Unknown",
]);

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeExtractedClaims(value: string): ExtractedClaims {
  try {
    const parsed: unknown = JSON.parse(value);
    const result = extractedClaimsSchema.safeParse(parsed);
    if (!result.success || result.data.claims.length === 0) {
      throw new PatentWatchDomainError("watch_claims_not_ready");
    }
    if (result.data.claims.some((claim) => claim.text.trim().length === 0)) {
      throw new PatentWatchDomainError("watch_claims_not_ready");
    }

    // Existing analyzeOverlap selects independent claims internally. When the
    // extractor marked none, the formal fallback rule is to analyze all claims.
    if (!result.data.claims.some((claim) => claim.isIndependent)) {
      return {
        ...result.data,
        claims: result.data.claims.map((claim) => ({
          ...claim,
          isIndependent: true,
          dependsOn: null,
        })),
      };
    }
    return result.data;
  } catch (error) {
    if (
      error instanceof PatentWatchDomainError &&
      error.code === "watch_claims_not_ready"
    ) {
      throw error;
    }
    throw new PatentWatchDomainError("watch_claims_not_ready");
  }
}

function validateRunStart(
  requestedCaseId: number,
  value: PatentWatchRunStart,
): PatentWatchRunStart {
  if (
    value.caseId !== requestedCaseId ||
    !isPositiveSafeInteger(value.caseId) ||
    !isPositiveSafeInteger(value.watchId) ||
    !isPositiveSafeInteger(value.runId) ||
    !isValidPatentWatchDate(value.monitoringFromDate) ||
    typeof value.extractedClaimsJson !== "string"
  ) {
    throw new PatentWatchDomainError("watch_unavailable");
  }

  const baseCursor =
    value.baseCursor === null
      ? parsePatentWatchCursor(null, null)
      : parsePatentWatchCursor(
          value.baseCursor.runUpdatedAt,
          value.baseCursor.importId,
        );
  const upperCursor =
    value.upperCursor === null
      ? parsePatentWatchCursor(null, null)
      : parsePatentWatchCursor(
          value.upperCursor.runUpdatedAt,
          value.upperCursor.importId,
        );

  if (
    (baseCursor !== null && upperCursor === null) ||
    (baseCursor !== null &&
      upperCursor !== null &&
      comparePatentWatchCursors(baseCursor, upperCursor) > 0)
  ) {
    throw new PatentWatchDomainError("watch_unavailable");
  }
  return { ...value, baseCursor, upperCursor };
}

function validateBatch(value: PatentWatchCorpusBatch): PatentWatchCorpusBatch {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray(value.documents) ||
    !nonNegativeSafeInteger(value.scannedImportRunCount) ||
    !nonNegativeSafeInteger(value.scannedDocumentCount) ||
    value.scannedDocumentCount < value.documents.length ||
    (value.documents.length > 0 && value.scannedImportRunCount === 0)
  ) {
    throw new PatentWatchDomainError("watch_corpus_unavailable");
  }
  return value;
}

function documentsWithinFixedRange(
  start: PatentWatchRunStart,
  documents: readonly PatentWatchCorpusDocument[],
): PatentWatchCorpusDocument[] {
  if (start.upperCursor === null) return [];

  return documents.filter((document) => {
    if (!isValidPatentWatchDate(document.publicationDate)) {
      throw new PatentWatchDomainError("watch_corpus_unavailable");
    }
    const cursor = parsePatentWatchCursor(
      document.importRunUpdatedAt,
      document.importId,
    );
    if (cursor === null) {
      throw new PatentWatchDomainError("watch_corpus_unavailable");
    }
    if (
      start.baseCursor !== null &&
      comparePatentWatchCursors(cursor, start.baseCursor) <= 0
    ) {
      return false;
    }
    if (comparePatentWatchCursors(cursor, start.upperCursor!) > 0) {
      return false;
    }
    return (
      start.baseCursor !== null ||
      document.publicationDate >= start.monitoringFromDate
    );
  });
}

function uniqueSourceKeys(
  documents: readonly PatentWatchCorpusDocument[],
): string[] {
  const keys = new Set<string>();
  for (const document of documents) {
    keys.add(
      createPatentWatchSourceKey(
        document.publicationNumber,
        document.contentSha256,
      ),
    );
  }
  return [...keys].sort();
}

function screeningSummaries(candidates: readonly PatentWatchPrefilterCandidate[]) {
  return candidates.map(({ document }) => ({
    docId: document.documentId,
    publicationNo: document.publicationNumber,
    title: document.inventionTitle,
    abstract: document.abstractText,
  }));
}

function analysisDetails(candidates: readonly PatentWatchPrefilterCandidate[]) {
  return candidates.map(({ document }) => ({
    docId: document.documentId,
    publicationNo: document.publicationNumber,
    title: document.inventionTitle,
    abstract: document.abstractText,
    claimsText: document.claimsText,
  }));
}

function selectScreenedCandidates(
  candidates: readonly PatentWatchPrefilterCandidate[],
  result: { relevantDocIds: number[]; reasoning: string },
): PatentWatchPrefilterCandidate[] {
  if (!result || !Array.isArray(result.relevantDocIds)) {
    throw new Error("invalid screening result");
  }
  const candidateById = new Map(
    candidates.map((candidate) => [candidate.document.documentId, candidate]),
  );
  const selected: PatentWatchPrefilterCandidate[] = [];
  const seen = new Set<number>();
  for (const documentId of result.relevantDocIds) {
    if (
      !isPositiveSafeInteger(documentId) ||
      seen.has(documentId) ||
      !candidateById.has(documentId)
    ) {
      continue;
    }
    seen.add(documentId);
    selected.push(candidateById.get(documentId)!);
    if (selected.length === MAX_ANALYSIS_CANDIDATES) break;
  }
  return selected;
}

function validScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateComparisonResult(
  value: ComparisonResult,
): ComparisonResult | null {
  if (
    !isPositiveSafeInteger(value.draftClaimNo) ||
    !isPositiveSafeInteger(value.priorDocId) ||
    !validScore(value.lexicalScore) ||
    !validScore(value.elementScore) ||
    !validScore(value.semanticScore) ||
    !validScore(value.structuralScore) ||
    !Array.isArray(value.matchedElements) ||
    !value.matchedElements.every((item) => typeof item === "string") ||
    !Array.isArray(value.unmatchedElements) ||
    !value.unmatchedElements.every((item) => typeof item === "string") ||
    !RISK_LABELS.has(value.riskLabel) ||
    typeof value.explanation !== "string"
  ) {
    return null;
  }
  return value;
}

function weightedOverall(value: ComparisonResult): number {
  return (
    0.3 * value.lexicalScore +
    0.35 * value.elementScore +
    0.2 * value.semanticScore +
    0.15 * value.structuralScore
  );
}

function betterComparison(
  left: ComparisonResult,
  right: ComparisonResult,
): ComparisonResult {
  const difference = weightedOverall(left) - weightedOverall(right);
  if (difference !== 0) return difference > 0 ? left : right;
  return left.draftClaimNo <= right.draftClaimNo ? left : right;
}

function abstractPreview(value: string | null): string | null {
  if (value === null) return null;
  return boundedPatentWatchPublicText(value, ABSTRACT_PREVIEW_LENGTH);
}

function forbiddenFullClaimTexts(
  extracted: ExtractedClaims,
  candidates: readonly PatentWatchPrefilterCandidate[],
): string[] {
  const forbidden = new Set(extracted.claims.map((claim) => claim.text));
  for (const candidate of candidates) {
    // Keep this projection aligned with analyzeOverlap's 2,000-character input.
    const sourceClaimsInput = candidate.document.claimsText.substring(0, 2_000);
    forbidden.add(sourceClaimsInput);
    for (const claim of sourceClaimsInput.split(/\r?\n\s*\r?\n/gu)) {
      const trimmed = claim.trim();
      if (trimmed) forbidden.add(trimmed);
    }
  }
  return [...forbidden];
}

function findingBase(
  candidate: PatentWatchPrefilterCandidate,
): Pick<
  PatentWatchFindingInsert,
  | "sourceKey"
  | "corpusDocumentId"
  | "packageType"
  | "kind"
  | "publicationNumber"
  | "publicationDate"
  | "inventionTitle"
  | "abstractPreview"
  | "reviewStatus"
> {
  const { document } = candidate;
  const inventionTitle = boundedPatentWatchPublicText(
    document.inventionTitle,
    500,
  ).trim();
  return {
    sourceKey: candidate.sourceKey,
    corpusDocumentId: document.documentId,
    packageType: document.packageType,
    kind: document.kind,
    publicationNumber: boundedPatentWatchPublicText(
      document.publicationNumber,
      100,
    ),
    publicationDate: document.publicationDate,
    inventionTitle: inventionTitle || "（発明名称なし）",
    abstractPreview: abstractPreview(document.abstractText),
    reviewStatus: "unreviewed",
  };
}

function buildAiFindings(
  extracted: ExtractedClaims,
  candidates: readonly PatentWatchPrefilterCandidate[],
  results: readonly ComparisonResult[],
): PatentWatchFindingInsert[] {
  const candidateIds = new Set(
    candidates.map((candidate) => candidate.document.documentId),
  );
  const bestByDocument = new Map<number, ComparisonResult>();
  const forbiddenFullTexts = forbiddenFullClaimTexts(extracted, candidates);

  for (const rawResult of results) {
    if (!candidateIds.has(rawResult?.priorDocId)) continue;
    const result = validateComparisonResult(rawResult);
    if (result === null) continue;
    const existing = bestByDocument.get(result.priorDocId);
    bestByDocument.set(
      result.priorDocId,
      existing === undefined ? result : betterComparison(existing, result),
    );
  }

  const findings: PatentWatchFindingInsert[] = [];
  for (const candidate of candidates) {
    const result = bestByDocument.get(candidate.document.documentId);
    if (result === undefined) continue;
    findings.push({
      ...findingBase(candidate),
      lexicalScore: result.lexicalScore,
      elementScore: result.elementScore,
      semanticScore: result.semanticScore,
      structuralScore: result.structuralScore,
      riskLabel: result.riskLabel,
      analysisJson: serializePatentWatchAnalysis(
        {
          matchedElements: result.matchedElements,
          unmatchedElements: result.unmatchedElements,
          explanation: result.explanation || SAFE_AI_EXPLANATION,
        },
        forbiddenFullTexts,
      ),
      analysisMode: "ai",
    });
  }
  return findings;
}

function buildFallbackFindings(
  extracted: ExtractedClaims,
  candidates: readonly PatentWatchPrefilterCandidate[],
): PatentWatchFindingInsert[] {
  const selected = candidates.slice(0, MAX_ANALYSIS_CANDIDATES);
  const forbiddenFullTexts = forbiddenFullClaimTexts(extracted, selected);
  return selected.map((candidate) => ({
    ...findingBase(candidate),
    lexicalScore: candidate.score,
    elementScore: 0,
    semanticScore: 0,
    structuralScore: 0,
    riskLabel: "Unknown",
    analysisJson: serializePatentWatchAnalysis(
      {
        matchedElements: candidate.matchedTokens.slice(0, 20),
        unmatchedElements: [],
        explanation: PATENT_WATCH_FALLBACK_EXPLANATION,
      },
      forbiddenFullTexts,
    ),
    analysisMode: "fallback",
  }));
}

function counts(
  batch: PatentWatchCorpusBatch,
  prefilteredCount: number,
  analyzedCount: number,
  findings: readonly PatentWatchFindingInsert[],
): PatentWatchRunCounts {
  return {
    scannedImportRunCount: batch.scannedImportRunCount,
    scannedDocumentCount: batch.scannedDocumentCount,
    prefilteredCount,
    analyzedCount,
    newFindingCount: findings.length,
    fallbackFindingCount: findings.filter(
      (finding) => finding.analysisMode === "fallback",
    ).length,
  };
}

async function failRun(
  caseId: number,
  runId: number,
  code: PatentWatchErrorCode,
  dependencies: PatentWatchAnalysisDependencies,
): Promise<never> {
  try {
    await dependencies.repository.finalizeRunFailure({
      caseId,
      runId,
      errorCode: code,
    });
  } catch {
    // The public error remains stable even if failure finalization is unavailable.
  }
  throw new PatentWatchDomainError(code);
}

export async function runPatentWatch(
  caseId: number,
  dependencies: PatentWatchAnalysisDependencies,
): Promise<CaseWatchRun> {
  if (!isPositiveSafeInteger(caseId)) {
    throw new PatentWatchDomainError("case_not_found");
  }

  let start: PatentWatchRunStart;
  try {
    start = validateRunStart(
      caseId,
      await dependencies.repository.startRun(caseId),
    );
  } catch (error) {
    throw new PatentWatchDomainError(stablePatentWatchErrorCode(error));
  }

  try {
    const extracted = safeExtractedClaims(start.extractedClaimsJson);
    const batch = validateBatch(
      await dependencies.repository.findDocumentsForRun(start.runId),
    );
    const documents = documentsWithinFixedRange(start, batch.documents);

    let findings: PatentWatchFindingInsert[] = [];
    let analyzedCount = 0;
    let analysisMode: PatentWatchAnalysisMode = "none";
    let candidates: PatentWatchPrefilterCandidate[] = [];

    if (documents.length > 0) {
      const sourceKeys = uniqueSourceKeys(documents);
      const existingSourceKeys = new Set(
        await dependencies.repository.findExistingSourceKeys(
          start.watchId,
          sourceKeys,
        ),
      );
      candidates = prefilterPatentWatchDocuments(extracted, documents, {
        existingSourceKeys,
        limit: MAX_SCREENING_CANDIDATES,
      });
    }

    if (candidates.length > 0) {
      try {
        const screening = await dependencies.screenPriorArt(
          extracted,
          screeningSummaries(candidates),
        );
        const selected = selectScreenedCandidates(candidates, screening);
        analysisMode = "ai";
        analyzedCount = selected.length;
        if (selected.length > 0) {
          const analysis = await dependencies.analyzeOverlap(
            extracted,
            analysisDetails(selected),
          );
          if (!Array.isArray(analysis)) throw new Error("invalid analysis");
          findings = buildAiFindings(extracted, selected, analysis);
        }
      } catch {
        findings = buildFallbackFindings(extracted, candidates);
        analyzedCount = findings.length;
        analysisMode = "fallback";
      }
    }

    return await dependencies.repository.finalizeRunSuccess({
      caseId,
      runId: start.runId,
      findings,
      counts: counts(
        batch,
        candidates.length,
        analyzedCount,
        findings,
      ),
      analysisMode,
    });
  } catch (error) {
    return failRun(
      caseId,
      start.runId,
      stablePatentWatchErrorCode(error),
      dependencies,
    );
  }
}
