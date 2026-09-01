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
import {
  buildKohoCorpusAttachPlan,
  KohoCorpusDomainError,
  type KohoCorpusSearchSummary,
  type KohoCorpusSourceDocument,
} from "../lib/koho-corpus/domain";
import { eq, desc, asc, and, inArray, or, sql } from "drizzle-orm";
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
  KohoCorpusRepository,
} from "./types";

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
