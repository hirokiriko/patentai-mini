export type KohoCorpusDomainErrorCode =
  | "invalid_query"
  | "invalid_limit"
  | "invalid_request"
  | "case_not_found"
  | "koho_document_not_found"
  | "ambiguous_publication_selection"
  | "koho_corpus_unavailable";

export class KohoCorpusDomainError extends Error {
  readonly code: KohoCorpusDomainErrorCode;

  constructor(code: KohoCorpusDomainErrorCode) {
    super(`Koho corpus operation failed: ${code}`);
    this.name = "KohoCorpusDomainError";
    this.code = code;
  }
}

export type KohoCorpusPackageType = "JPA" | "JPB";
export type KohoCorpusParseStatus = "success" | "review_required";
export type KohoCorpusDocumentKind = "A1" | "P1" | "B1" | "B2";

export interface KohoCorpusSourceDocument {
  documentId: number;
  importId: number;
  packageType: KohoCorpusPackageType;
  sourceSha256: string;
  normalizedEntryPath: string;
  parseStatus: KohoCorpusParseStatus;
  kind: KohoCorpusDocumentKind;
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

export interface KohoCorpusSearchSummary {
  documentId: number;
  packageType: KohoCorpusPackageType;
  parseStatus: KohoCorpusParseStatus;
  kind: KohoCorpusDocumentKind;
  publicationNumber: string;
  applicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractPreview: string | null;
}

export interface KohoCorpusSnapshot {
  caseId: number;
  publicationNo: string;
  title: string;
  abstract: string | null;
  claimsText: string;
  normalizedElementsJson: null;
  sourceCsvRowJson: string;
}

export interface KohoCorpusExistingPriorArt {
  docId: number;
  caseId: number;
  publicationNo: string | null;
  title: string | null;
  abstract: string | null;
  claimsText: string | null;
  normalizedElementsJson: string | null;
  sourceCsvRowJson: string | null;
}

export interface KohoCorpusInsertOperation {
  sourceDocumentId: number;
  snapshot: KohoCorpusSnapshot;
}

export interface KohoCorpusUpdateOperation
  extends KohoCorpusInsertOperation {
  docId: number;
}

export interface KohoCorpusUnchangedOperation {
  sourceDocumentId: number;
  docId: number;
}

export interface KohoCorpusAttachPlan {
  selected: number;
  inserted: KohoCorpusInsertOperation[];
  updated: KohoCorpusUpdateOperation[];
  unchanged: KohoCorpusUnchangedOperation[];
  analysisCleared: boolean;
}

export interface KohoCorpusAttachResult {
  selected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  analysisCleared: boolean;
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PUBLICATION_DATE_PATTERN = /^[0-9]{8}$/;
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

function isValidYyyyMmDd(value: string): boolean {
  if (!PUBLICATION_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
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

function unavailable(): never {
  throw new KohoCorpusDomainError("koho_corpus_unavailable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function sourceDocument(value: unknown): KohoCorpusSourceDocument {
  if (!isRecord(value)) unavailable();
  if (!positiveSafeInteger(value.documentId)) unavailable();
  if (!positiveSafeInteger(value.importId)) unavailable();
  if (!PACKAGE_TYPES.has(value.packageType as KohoCorpusPackageType)) {
    unavailable();
  }
  if (!PARSE_STATUSES.has(value.parseStatus as KohoCorpusParseStatus)) {
    unavailable();
  }
  if (!DOCUMENT_KINDS.has(value.kind as KohoCorpusDocumentKind)) {
    unavailable();
  }
  const packageType = value.packageType as KohoCorpusPackageType;
  const kind = value.kind as KohoCorpusDocumentKind;
  if (
    (packageType === "JPA" && kind !== "A1" && kind !== "P1") ||
    (packageType === "JPB" && kind !== "B1" && kind !== "B2")
  ) {
    unavailable();
  }
  if (
    typeof value.sourceSha256 !== "string" ||
    !SHA256_PATTERN.test(value.sourceSha256) ||
    typeof value.contentSha256 !== "string" ||
    !SHA256_PATTERN.test(value.contentSha256)
  ) {
    unavailable();
  }
  if (
    typeof value.normalizedEntryPath !== "string" ||
    value.normalizedEntryPath.length === 0 ||
    value.normalizedEntryPath.includes("\\") ||
    typeof value.publicationNumber !== "string" ||
    value.publicationNumber.length === 0 ||
    typeof value.applicationNumber !== "string" ||
    typeof value.publicationDate !== "string" ||
    !isValidYyyyMmDd(value.publicationDate) ||
    typeof value.inventionTitle !== "string" ||
    typeof value.claimsText !== "string" ||
    !nullableString(value.registrationNumber) ||
    !nullableString(value.registrationDate) ||
    !nullableString(value.abstractText)
  ) {
    unavailable();
  }
  for (const jsonField of [
    "applicantsJson",
    "ipcJson",
    "fiJson",
    "parseIssuesJson",
    "sourceMetadataJson",
  ] as const) {
    if (typeof value[jsonField] !== "string") unavailable();
  }

  return {
    documentId: value.documentId,
    importId: value.importId,
    packageType,
    sourceSha256: value.sourceSha256,
    normalizedEntryPath: value.normalizedEntryPath,
    parseStatus: value.parseStatus as KohoCorpusParseStatus,
    kind,
    publicationNumber: value.publicationNumber,
    applicationNumber: value.applicationNumber,
    publicationDate: value.publicationDate,
    registrationNumber: value.registrationNumber,
    registrationDate: value.registrationDate,
    inventionTitle: value.inventionTitle,
    abstractText: value.abstractText,
    claimsText: value.claimsText,
    applicantsJson: value.applicantsJson as string,
    ipcJson: value.ipcJson as string,
    fiJson: value.fiJson as string,
    parseIssuesJson: value.parseIssuesJson as string,
    sourceMetadataJson: value.sourceMetadataJson as string,
    contentSha256: value.contentSha256,
  };
}

function existingPriorArt(value: unknown): KohoCorpusExistingPriorArt {
  if (!isRecord(value)) unavailable();
  if (!positiveSafeInteger(value.docId)) unavailable();
  if (!positiveSafeInteger(value.caseId)) unavailable();
  if (
    !nullableString(value.publicationNo) ||
    !nullableString(value.title) ||
    !nullableString(value.abstract) ||
    !nullableString(value.claimsText) ||
    !nullableString(value.normalizedElementsJson) ||
    !nullableString(value.sourceCsvRowJson)
  ) {
    unavailable();
  }
  return {
    docId: value.docId,
    caseId: value.caseId,
    publicationNo: value.publicationNo,
    title: value.title,
    abstract: value.abstract,
    claimsText: value.claimsText,
    normalizedElementsJson: value.normalizedElementsJson,
    sourceCsvRowJson: value.sourceCsvRowJson,
  };
}

function normalizeQuery(values: string[]): string {
  if (values.length !== 1) {
    throw new KohoCorpusDomainError("invalid_query");
  }
  const query = values[0].trim();
  const length = Array.from(query).length;
  if (length < 2 || length > 100) {
    throw new KohoCorpusDomainError("invalid_query");
  }
  return query;
}

function normalizeLimit(values: string[]): number {
  if (values.length === 0) return 20;
  if (values.length !== 1 || !/^[0-9]+$/.test(values[0])) {
    throw new KohoCorpusDomainError("invalid_limit");
  }
  const limit = Number(values[0]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new KohoCorpusDomainError("invalid_limit");
  }
  return limit;
}

export function parseKohoCorpusSearchParams(params: URLSearchParams): {
  query: string;
  limit: number;
} {
  return {
    query: normalizeQuery(params.getAll("q")),
    limit: normalizeLimit(params.getAll("limit")),
  };
}

function publicSummary(
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

function compareSearchOrder(
  left: KohoCorpusSourceDocument,
  right: KohoCorpusSourceDocument,
): number {
  if (left.publicationDate !== right.publicationDate) {
    return left.publicationDate > right.publicationDate ? -1 : 1;
  }
  if (left.publicationNumber !== right.publicationNumber) {
    return left.publicationNumber < right.publicationNumber ? -1 : 1;
  }
  return left.documentId - right.documentId;
}

export function searchKohoCorpusDocuments(
  values: readonly unknown[],
  queryValue: string,
  limit: number,
): KohoCorpusSearchSummary[] {
  const query = normalizeQuery([queryValue]);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new KohoCorpusDomainError("invalid_limit");
  }
  const normalizedQuery = query.toLowerCase();
  return values
    .map(sourceDocument)
    .filter((document) =>
      [
        document.publicationNumber,
        document.applicationNumber,
        document.inventionTitle,
      ].some((candidate) =>
        candidate.toLowerCase().includes(normalizedQuery),
      ),
    )
    .sort(compareSearchOrder)
    .slice(0, limit)
    .map(publicSummary);
}

export function validateKohoCorpusAttachRequest(value: unknown): number[] {
  if (!isRecord(value)) {
    throw new KohoCorpusDomainError("invalid_request");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "documentIds") {
    throw new KohoCorpusDomainError("invalid_request");
  }
  if (
    !Array.isArray(value.documentIds) ||
    value.documentIds.length < 1 ||
    value.documentIds.length > 50
  ) {
    throw new KohoCorpusDomainError("invalid_request");
  }
  const documentIds = value.documentIds;
  if (!documentIds.every(positiveSafeInteger)) {
    throw new KohoCorpusDomainError("invalid_request");
  }
  if (new Set(documentIds).size !== documentIds.length) {
    throw new KohoCorpusDomainError("invalid_request");
  }
  return [...documentIds];
}

export function buildKohoCorpusSnapshot(
  caseId: number,
  value: unknown,
): KohoCorpusSnapshot {
  if (!positiveSafeInteger(caseId)) {
    throw new KohoCorpusDomainError("case_not_found");
  }
  const document = sourceDocument(value);
  const sourceCsvRowJson = JSON.stringify({
    source: "koho-corpus",
    packageType: document.packageType,
    sourceSha256: document.sourceSha256,
    normalizedEntryPath: document.normalizedEntryPath,
    parseStatus: document.parseStatus,
    kind: document.kind,
    publicationDate: document.publicationDate,
    contentSha256: document.contentSha256,
  });
  if (sourceCsvRowJson === undefined) unavailable();
  return {
    caseId,
    publicationNo: document.publicationNumber,
    title: document.inventionTitle,
    abstract: document.abstractText,
    claimsText: document.claimsText,
    normalizedElementsJson: null,
    sourceCsvRowJson,
  };
}

function snapshotMatches(
  existing: KohoCorpusExistingPriorArt,
  snapshot: KohoCorpusSnapshot,
): boolean {
  return (
    existing.caseId === snapshot.caseId &&
    existing.publicationNo === snapshot.publicationNo &&
    existing.title === snapshot.title &&
    existing.abstract === snapshot.abstract &&
    existing.claimsText === snapshot.claimsText &&
    existing.normalizedElementsJson === snapshot.normalizedElementsJson &&
    existing.sourceCsvRowJson === snapshot.sourceCsvRowJson
  );
}

export function buildKohoCorpusAttachPlan(input: {
  caseId: number;
  documentIds: readonly number[];
  documents: readonly unknown[];
  existingDocuments: readonly unknown[];
}): KohoCorpusAttachPlan {
  if (!positiveSafeInteger(input.caseId)) {
    throw new KohoCorpusDomainError("case_not_found");
  }
  const documentIds = validateKohoCorpusAttachRequest({
    documentIds: [...input.documentIds],
  });
  const documentsById = new Map<number, KohoCorpusSourceDocument>();
  for (const value of input.documents) {
    const document = sourceDocument(value);
    if (documentsById.has(document.documentId)) unavailable();
    documentsById.set(document.documentId, document);
  }

  const selectedDocuments = documentIds.map((documentId) => {
    const document = documentsById.get(documentId);
    if (document === undefined) {
      throw new KohoCorpusDomainError("koho_document_not_found");
    }
    return document;
  });
  const selectedPublications = new Set<string>();
  for (const document of selectedDocuments) {
    if (selectedPublications.has(document.publicationNumber)) {
      throw new KohoCorpusDomainError(
        "ambiguous_publication_selection",
      );
    }
    selectedPublications.add(document.publicationNumber);
  }

  const existingByPublication = new Map<
    string,
    KohoCorpusExistingPriorArt
  >();
  for (const value of input.existingDocuments) {
    const existing = existingPriorArt(value);
    if (existing.caseId !== input.caseId) unavailable();
    if (existing.publicationNo === null) continue;
    if (existingByPublication.has(existing.publicationNo)) unavailable();
    existingByPublication.set(existing.publicationNo, existing);
  }

  const inserted: KohoCorpusInsertOperation[] = [];
  const updated: KohoCorpusUpdateOperation[] = [];
  const unchanged: KohoCorpusUnchangedOperation[] = [];
  for (const document of selectedDocuments) {
    const snapshot = buildKohoCorpusSnapshot(input.caseId, document);
    const existing = existingByPublication.get(snapshot.publicationNo);
    if (existing === undefined) {
      inserted.push({
        sourceDocumentId: document.documentId,
        snapshot,
      });
    } else if (snapshotMatches(existing, snapshot)) {
      unchanged.push({
        sourceDocumentId: document.documentId,
        docId: existing.docId,
      });
    } else {
      updated.push({
        sourceDocumentId: document.documentId,
        docId: existing.docId,
        snapshot,
      });
    }
  }

  return {
    selected: selectedDocuments.length,
    inserted,
    updated,
    unchanged,
    analysisCleared: inserted.length > 0 || updated.length > 0,
  };
}

export function summarizeKohoCorpusAttachPlan(
  plan: KohoCorpusAttachPlan,
): KohoCorpusAttachResult {
  return {
    selected: plan.selected,
    inserted: plan.inserted.length,
    updated: plan.updated.length,
    unchanged: plan.unchanged.length,
    analysisCleared: plan.analysisCleared,
  };
}
