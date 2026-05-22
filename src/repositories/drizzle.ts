import { db } from "@/db";
import {
  cases,
  draftPatents,
  searchQuerySets,
  priorArtDocuments,
  comparisonResults,
} from "@/db/schema";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import type {
  CaseRepository,
  DraftPatentRepository,
  SearchQuerySetRepository,
  PriorArtDocumentRepository,
  ComparisonResultRepository,
  DraftKind,
} from "./types";

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
