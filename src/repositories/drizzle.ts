import { db } from "@/db";
import {
  cases,
  draftPatents,
  searchQuerySets,
  priorArtDocuments,
  comparisonResults,
} from "@/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
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
    const updates: Record<string, unknown> = { updatedAt: sql`datetime('now')` };
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
    const [row] = await db.delete(cases).where(eq(cases.caseId, caseId)).returning();
    return !!row;
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
    const inserted = await db.insert(priorArtDocuments).values(docs).returning();
    return inserted.length;
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
