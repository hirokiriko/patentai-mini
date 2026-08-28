import {
  KohoCorpusDomainError,
  parseKohoCorpusSearchParams,
  validateKohoCorpusAttachRequest,
  type KohoCorpusAttachResult,
  type KohoCorpusDocumentKind,
  type KohoCorpusPackageType,
  type KohoCorpusParseStatus,
  type KohoCorpusSearchSummary,
} from "./domain";

export interface KohoCorpusApiRepository {
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

export interface KohoCorpusHandlerDependencies {
  repository: KohoCorpusApiRepository;
}

export interface KohoCorpusRouteContext {
  params: Promise<{ caseId: string }>;
}

const PACKAGE_TYPES = new Set<KohoCorpusPackageType>(["JPA", "JPB"]);
const PARSE_STATUSES = new Set<KohoCorpusParseStatus>([
  "success",
  "review_required",
]);
const DOCUMENT_KINDS = new Set<KohoCorpusDocumentKind>([
  "A1",
  "P1",
  "B1",
  "B2",
]);
const POSTGRES_INTEGER_MAX = 2_147_483_647;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function unavailable(): never {
  throw new KohoCorpusDomainError("koho_corpus_unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function parseCaseId(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new KohoCorpusDomainError("case_not_found");
  }
  const caseId = Number(value);
  if (
    !positiveSafeInteger(caseId) ||
    caseId > POSTGRES_INTEGER_MAX
  ) {
    throw new KohoCorpusDomainError("case_not_found");
  }
  return caseId;
}

function projectSearchSummary(value: unknown): KohoCorpusSearchSummary {
  if (!isRecord(value)) unavailable();
  if (!positiveSafeInteger(value.documentId)) unavailable();
  if (!PACKAGE_TYPES.has(value.packageType as KohoCorpusPackageType)) {
    unavailable();
  }
  if (!PARSE_STATUSES.has(value.parseStatus as KohoCorpusParseStatus)) {
    unavailable();
  }
  if (!DOCUMENT_KINDS.has(value.kind as KohoCorpusDocumentKind)) {
    unavailable();
  }
  if (
    (value.packageType === "JPA" &&
      value.kind !== "A1" &&
      value.kind !== "P1") ||
    (value.packageType === "JPB" &&
      value.kind !== "B1" &&
      value.kind !== "B2")
  ) {
    unavailable();
  }
  if (
    typeof value.publicationNumber !== "string" ||
    typeof value.applicationNumber !== "string" ||
    typeof value.publicationDate !== "string" ||
    !/^[0-9]{8}$/.test(value.publicationDate) ||
    typeof value.inventionTitle !== "string" ||
    (value.abstractPreview !== null &&
      typeof value.abstractPreview !== "string")
  ) {
    unavailable();
  }
  return {
    documentId: value.documentId,
    packageType: value.packageType as KohoCorpusPackageType,
    parseStatus: value.parseStatus as KohoCorpusParseStatus,
    kind: value.kind as KohoCorpusDocumentKind,
    publicationNumber: value.publicationNumber,
    applicationNumber: value.applicationNumber,
    publicationDate: value.publicationDate,
    inventionTitle: value.inventionTitle,
    abstractPreview:
      value.abstractPreview === null
        ? null
        : Array.from(value.abstractPreview).slice(0, 300).join(""),
  };
}

function projectAttachResult(value: unknown): KohoCorpusAttachResult {
  if (!isRecord(value)) unavailable();
  if (
    !nonNegativeSafeInteger(value.selected) ||
    !nonNegativeSafeInteger(value.inserted) ||
    !nonNegativeSafeInteger(value.updated) ||
    !nonNegativeSafeInteger(value.unchanged) ||
    typeof value.analysisCleared !== "boolean"
  ) {
    unavailable();
  }
  if (
    value.selected !== value.inserted + value.updated + value.unchanged ||
    value.analysisCleared !== (value.inserted > 0 || value.updated > 0)
  ) {
    unavailable();
  }
  return {
    selected: value.selected,
    inserted: value.inserted,
    updated: value.updated,
    unchanged: value.unchanged,
    analysisCleared: value.analysisCleared,
  };
}

function errorResponse(error: unknown): Response {
  if (!(error instanceof KohoCorpusDomainError)) {
    return jsonResponse({ error: "koho_corpus_internal_error" }, 500);
  }
  switch (error.code) {
    case "invalid_query":
    case "invalid_limit":
    case "invalid_request":
      return jsonResponse({ error: error.code }, 400);
    case "case_not_found":
    case "koho_document_not_found":
      return jsonResponse({ error: error.code }, 404);
    case "ambiguous_publication_selection":
      return jsonResponse({ error: error.code }, 409);
    case "koho_corpus_unavailable":
      return jsonResponse({ error: error.code }, 503);
  }
  return jsonResponse({ error: "koho_corpus_internal_error" }, 500);
}

export function createKohoCorpusHandlers(
  dependencies: KohoCorpusHandlerDependencies,
) {
  return {
    async GET(
      request: Request,
      context: KohoCorpusRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        const { query, limit } = parseKohoCorpusSearchParams(
          new URL(request.url).searchParams,
        );
        const items = await dependencies.repository.searchForCase(
          caseId,
          query,
          limit,
        );
        if (!Array.isArray(items)) unavailable();
        return jsonResponse({ items: items.map(projectSearchSummary) });
      } catch (error) {
        return errorResponse(error);
      }
    },

    async POST(
      request: Request,
      context: KohoCorpusRouteContext,
    ): Promise<Response> {
      try {
        const { caseId: caseIdText } = await context.params;
        const caseId = parseCaseId(caseIdText);
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          throw new KohoCorpusDomainError("invalid_request");
        }
        const documentIds = validateKohoCorpusAttachRequest(body);
        const result = await dependencies.repository.attachToCase(
          caseId,
          documentIds,
        );
        return jsonResponse(projectAttachResult(result));
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}
