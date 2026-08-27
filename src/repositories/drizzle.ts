import { db } from "@/db";
import {
  cases,
  draftPatents,
  searchQuerySets,
  priorArtDocuments,
  comparisonResults,
  kohoImportDocuments,
  kohoImportRuns,
} from "@/db/schema";
import { inspectKohoEntryPath } from "@/lib/koho-xml/path";
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

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isJsonText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isExpectedDocumentPath(
  packageType: KohoImportRun["packageType"],
  kind: KohoImportDocument["kind"],
  normalizedEntryPath: string,
): boolean {
  const path = inspectKohoEntryPath(normalizedEntryPath);
  if (
    !path.ok ||
    path.normalizedPath !== normalizedEntryPath ||
    !path.isPrimaryXml
  ) {
    return false;
  }

  if (packageType === "JPA") {
    return (
      (kind === "A1" && path.section === "P_A1") ||
      (kind === "P1" && path.section === "P_P1")
    );
  }
  return (kind === "B1" || kind === "B2") && path.section === "P_B1";
}

function isNormalizedPrimaryXmlPath(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const path = inspectKohoEntryPath(value);
  return path.ok && path.normalizedPath === value && path.isPrimaryXml;
}

function assertImportId(importId: unknown): asserts importId is number {
  if (!Number.isSafeInteger(importId) || (importId as number) <= 0) {
    invalid("invalid_import_id");
  }
}

function assertPlan(
  plan: Parameters<KohoImportRepository["savePlan"]>[0] | null | undefined,
): asserts plan is Parameters<KohoImportRepository["savePlan"]>[0] {
  if (!plan || typeof plan !== "object") {
    invalid("invalid_document_payload");
  }
  assertPackageType(plan.packageType);
  assertSha256(plan.sourceSha256, "invalid_source_sha256");
  assertPackageStatus(plan.packageStatus);

  if (
    !Array.isArray(plan.documents) ||
    !isNonNegativeInteger(plan.documentCount) ||
    plan.documentCount !== plan.documents.length ||
    !isNonNegativeInteger(plan.amendmentCount) ||
    !isNonNegativeInteger(plan.nestedSt26Count)
  ) {
    invalid("invalid_document_count");
  }
  if (!isJsonText(plan.countsJson) || !isJsonText(plan.issuesJson)) {
    invalid("invalid_document_payload");
  }

  const paths = new Set<string>();
  for (const document of plan.documents) {
    assertDocumentParseStatus(document.parseStatus);
    assertDocumentKind(document.kind);
    assertSha256(document.contentSha256, "invalid_content_sha256");

    if (
      typeof document.normalizedEntryPath !== "string" ||
      !isExpectedDocumentPath(
        plan.packageType,
        document.kind,
        document.normalizedEntryPath,
      )
    ) {
      invalid("invalid_normalized_entry_path");
    }
    if (paths.has(document.normalizedEntryPath)) {
      invalid("duplicate_normalized_entry_path");
    }
    paths.add(document.normalizedEntryPath);

    if (
      typeof document.publicationNumber !== "string" ||
      typeof document.applicationNumber !== "string" ||
      typeof document.publicationDate !== "string" ||
      !isNullableString(document.registrationNumber) ||
      !isNullableString(document.registrationDate) ||
      typeof document.inventionTitle !== "string" ||
      !isNullableString(document.abstractText) ||
      typeof document.claimsText !== "string" ||
      !isJsonText(document.applicantsJson) ||
      !isJsonText(document.ipcJson) ||
      !isJsonText(document.fiJson) ||
      !isJsonText(document.parseIssuesJson) ||
      !isJsonText(document.sourceMetadataJson)
    ) {
      invalid("invalid_document_payload");
    }
  }
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
  if (
    !isNonNegativeInteger(row.documentCount) ||
    !isNonNegativeInteger(row.amendmentCount) ||
    !isNonNegativeInteger(row.nestedSt26Count) ||
    !isJsonText(row.countsJson) ||
    !isJsonText(row.issuesJson) ||
    typeof row.createdAt !== "string" ||
    typeof row.updatedAt !== "string"
  ) {
    invalid("invalid_document_payload");
  }
  return { ...row, packageType, packageStatus };
}

function toKohoImportDocument(
  row: typeof kohoImportDocuments.$inferSelect,
): KohoImportDocument {
  const parseStatus = row.parseStatus;
  const kind = row.kind;
  assertImportId(row.documentId);
  assertImportId(row.importId);
  assertDocumentParseStatus(parseStatus);
  assertDocumentKind(kind);
  assertSha256(row.contentSha256, "invalid_content_sha256");

  if (
    !isNormalizedPrimaryXmlPath(row.normalizedEntryPath) ||
    typeof row.publicationNumber !== "string" ||
    typeof row.applicationNumber !== "string" ||
    typeof row.publicationDate !== "string" ||
    !isNullableString(row.registrationNumber) ||
    !isNullableString(row.registrationDate) ||
    typeof row.inventionTitle !== "string" ||
    !isNullableString(row.abstractText) ||
    typeof row.claimsText !== "string" ||
    !isJsonText(row.applicantsJson) ||
    !isJsonText(row.ipcJson) ||
    !isJsonText(row.fiJson) ||
    !isJsonText(row.parseIssuesJson) ||
    !isJsonText(row.sourceMetadataJson)
  ) {
    invalid("invalid_document_payload");
  }
  return { ...row, parseStatus, kind };
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
    assertPlan(plan);

    return db.transaction(async (tx) => {
      const [runRow] = await tx
        .insert(kohoImportRuns)
        .values({
          packageType: plan.packageType,
          sourceSha256: plan.sourceSha256,
          packageStatus: plan.packageStatus,
          documentCount: plan.documentCount,
          amendmentCount: plan.amendmentCount,
          nestedSt26Count: plan.nestedSt26Count,
          countsJson: plan.countsJson,
          issuesJson: plan.issuesJson,
        })
        .onConflictDoUpdate({
          target: [kohoImportRuns.packageType, kohoImportRuns.sourceSha256],
          set: {
            packageStatus: plan.packageStatus,
            documentCount: plan.documentCount,
            amendmentCount: plan.amendmentCount,
            nestedSt26Count: plan.nestedSt26Count,
            countsJson: plan.countsJson,
            issuesJson: plan.issuesJson,
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
      if (plan.documents.length > 0) {
        const inserted = await tx
          .insert(kohoImportDocuments)
          .values(
            plan.documents.map((document) => ({
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

    const rows = await db
      .select()
      .from(kohoImportDocuments)
      .where(eq(kohoImportDocuments.importId, importId))
      .orderBy(
        asc(kohoImportDocuments.normalizedEntryPath),
        asc(kohoImportDocuments.documentId),
      );
    return rows.map(toKohoImportDocument);
  },
};
