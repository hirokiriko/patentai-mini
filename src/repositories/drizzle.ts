import { db } from "../db";
import {
  cases,
  draftPatents,
  searchQuerySets,
  priorArtDocuments,
  comparisonResults,
  kohoImportDocuments,
  kohoImportRuns,
} from "../db/schema";
import {
  assertKohoImportDocumentPlan,
  assertKohoImportRunContract,
  createKohoImportPlanSnapshot,
  KohoImportPlanValidationError,
  type KohoImportDocumentPlan,
  type KohoImportRunContract,
} from "../lib/koho-import";
import { eq, desc, asc, and, inArray, sql } from "drizzle-orm";
import { KohoImportRepositoryValidationError } from "./types";
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
} from "./types";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
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
            updatedAt: sql`now()`,
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
