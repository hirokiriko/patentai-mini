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
