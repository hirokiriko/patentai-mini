import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cases, comparisonResults, draftPatents, priorArtDocuments } from "@/db/schema";
import { lockManagedCase } from "@/repositories/managed-case-graph";
import { ComparisonError, digest, parseComparisonSource, type SourceSnapshot } from "./source";
import { executeComparison } from "./execute";
import { makePlan, validateSaved, type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { hasSavedComparisonMarker } from "./marker";

type Database = Pick<typeof db, "select" | "execute" | "insert">;
async function rawInputs(database: Database, caseId: number, lock = false) {
  let caseQuery = database.select().from(cases).where(eq(cases.caseId, caseId));
  if (lock) caseQuery = caseQuery.for("update") as typeof caseQuery;
  const [caseRow] = await caseQuery;
  if (!caseRow) throw new ComparisonError("not_found");
  let draftQuery = database.select().from(draftPatents).where(and(eq(draftPatents.caseId, caseId), eq(draftPatents.kind, "main"))).orderBy(asc(draftPatents.draftId));
  let documentQuery = database.select().from(priorArtDocuments).where(eq(priorArtDocuments.caseId, caseId)).orderBy(asc(priorArtDocuments.docId));
  if (lock) { draftQuery = draftQuery.for("share") as typeof draftQuery; documentQuery = documentQuery.for("share") as typeof documentQuery; }
  const drafts = await draftQuery;
  const documents = await documentQuery;
  const draft = drafts.at(-1);
  const inputDigest = digest({ caseId, title: caseRow.title, draft: draft ? { id: draft.draftId, text: draft.parsedText } : null,
    documents: documents.map(d => ({ id: d.docId, publication: d.publicationNo, title: d.title, text: d.claimsText })) });
  return { caseId, title: caseRow.title, draft, documents, inputDigest };
}
function snapshot(text: string | null, id: number, label: string): SourceSnapshot | null {
  try { return parseComparisonSource(text, id, label); } catch { return null; }
}
export async function comparisonCatalog(caseId: number) {
  const raw = await rawInputs(db, caseId);
  return { caseId, title: raw.title, inputDigest: raw.inputDigest,
    draft: raw.draft ? { id: raw.draft.draftId, source: snapshot(raw.draft.parsedText, raw.draft.draftId, `draft-${raw.draft.draftId}`) } : null,
    documents: raw.documents.map(d => ({ id: d.docId, title: d.title, publicationNo: d.publicationNo,
      source: snapshot(d.claimsText, d.docId, d.publicationNo || `document-${d.docId}`) })) };
}
type ResultRow = typeof comparisonResults.$inferSelect;
function envelope(row: ResultRow): unknown {
  try { return JSON.parse(row.matchedElementsJson ?? "null")?.priorArtComparison; } catch { return null; }
}
function readGroups(rows: ResultRow[], caseId: number) {
  const groups = new Map<string, { saved: SavedComparison; rows: ResultRow[] }>();
  const tainted = new Set<string>();
  const reserved = new Set<string>();
  let legacyCount = 0, invalidCount = 0;
  for (const row of rows) {
    const value = envelope(row);
    if (!value) { if (hasSavedComparisonMarker(row.matchedElementsJson)) invalidCount++; else legacyCount++; continue; }
    if (typeof value === "object" && "status" in value && value.status === "reserved" && "operationId" in value && typeof value.operationId === "string") {
      reserved.add(value.operationId); tainted.add(value.operationId); continue;
    }
    try {
      const saved = validateSaved(value);
      if (saved.inputs.caseId !== caseId || row.caseId !== caseId) throw Error();
      const group = groups.get(saved.operationId);
      if (group && digest(group.saved) !== digest(saved)) throw Error();
      if (group) group.rows.push(row); else groups.set(saved.operationId, { saved, rows: [row] });
    } catch {
      invalidCount++;
      if (value && typeof value === "object" && "operationId" in value && typeof value.operationId === "string") tainted.add(value.operationId);
    }
  }
  const results: SavedComparison[] = [];
  for (const { saved, rows: members } of groups.values()) {
    const expected = new Set(saved.pairs.map(p => `${p.baseClaimNo}:${p.docId}`));
    const actual = members.map(r => `${r.draftClaimId}:${r.priorDocId ?? JSON.parse(r.matchedElementsJson!).detachedPriorDocId}`);
    if (tainted.has(saved.operationId) || actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some(k => !expected.has(k))) { invalidCount++; continue; }
    results.push(saved);
  }
  return { results: results.sort((a,b) => b.generatedAt.localeCompare(a.generatedAt)), legacyCount, invalidCount, reservedCount: reserved.size };
}
async function savedResults(database: Database, caseId: number) {
  return readGroups(await database.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId)).orderBy(asc(comparisonResults.resultId)), caseId);
}
export async function listComparisons(caseId: number) {
  const raw = await rawInputs(db, caseId);
  return { ...await savedResults(db, caseId), currentInputDigest: raw.inputDigest };
}
export async function getComparison(caseId: number, operationId: string) {
  const data = await listComparisons(caseId);
  const saved = data.results.find(r => r.operationId === operationId);
  if (!saved) throw new ComparisonError("not_found");
  return { saved, stale: saved.inputs.inputDigest !== data.currentInputDigest };
}

/** Commit a durable no-retry reservation BEFORE dispatch. A missing commit ACK
 * never permits a send. Failed/unknown attempts keep the reservation across
 * processes and restarts; only complete results are downloadable. */
export async function runAndSaveComparison(caseId: number, selection: Selection) {
  let saveStarted = false;
  try {
    const reservation = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(150, ${caseId}) as acquired`);
      if (locked.rows[0]?.acquired !== true) throw new ComparisonError("save_unconfirmed");
      const stored = await savedResults(tx, caseId);
      const existing = stored.results.find(r => r.operationId === selection.operationId);
      if (existing) {
        if (digest(existing.selection) !== digest(selection)) throw new ComparisonError("selection_invalid");
        return { existing };
      }
      if (stored.invalidCount) throw new ComparisonError("result_invalid");
      if (stored.reservedCount) throw new ComparisonError("save_unconfirmed");
      const rows = await tx.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
      if (rows.some(row => {
        const value = envelope(row);
        return value && typeof value === "object" && "operationId" in value && value.operationId === selection.operationId;
      })) throw new ComparisonError("save_unconfirmed");
      await lockManagedCase(tx, caseId);
      const raw = await rawInputs(tx, caseId, true);
      if (raw.inputDigest !== selection.inputDigest) throw new ComparisonError("stale_input");
      if (!raw.draft) throw new ComparisonError("source_review_required");
      const inputs: ComparisonInputs = { caseId, title: raw.title, inputDigest: raw.inputDigest,
        draft: parseComparisonSource(raw.draft.parsedText, raw.draft.draftId, `draft-${raw.draft.draftId}`),
        documents: selection.documents.map(s => {
          const d = raw.documents.find(d => d.docId === s.docId);
          if (!d) throw new ComparisonError("selection_invalid");
          return parseComparisonSource(d.claimsText, d.docId, d.publicationNo || `document-${d.docId}`);
        }) };
      makePlan(inputs, selection);
      const groups = selection.documents.flatMap(d => selection.draftClaimNos.map(claimNo => ({ docId: d.docId, claimNo })));
      const reservedRows = await tx.insert(comparisonResults).values(groups.map(p => ({ caseId, draftClaimId: String(p.claimNo), priorDocId: p.docId,
        matchedElementsJson: JSON.stringify({ matched: [], unmatched: [], explanation: "完了未確認の指定比較です。再実行せず保存結果を照合してください。",
          priorArtComparison: { version: 1, status: "reserved", operationId: selection.operationId, selection } }),
      }))).returning({ id: comparisonResults.resultId });
      return { inputs, ids: reservedRows.map(r => r.id) };
    });
    if (reservation.existing) return reservation.existing;
    const { inputs, ids } = reservation;
    const saved = await executeComparison(inputs!, selection);
    saveStarted = true;
    return await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await lockManagedCase(tx, caseId);
      const current = await rawInputs(tx, caseId, true);
      if (current.inputDigest !== inputs!.inputDigest) throw new ComparisonError("stale_input");
      const reservedRows = await tx.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
      const ownRows = reservedRows.filter(r => {
        const marker = envelope(r) as { operationId?: unknown } | null;
        return marker?.operationId === selection.operationId;
      });
      const expectedKeys = new Set(selection.documents.flatMap(d => selection.draftClaimNos.map(n => `${n}:${d.docId}`)));
      if (ownRows.length !== ids!.length || ownRows.some(r => !ids!.includes(r.resultId) ||
          digest(envelope(r)) !== digest({ version: 1, status: "reserved", operationId: selection.operationId, selection }) ||
          !expectedKeys.delete(`${r.draftClaimId}:${r.priorDocId}`)) || expectedKeys.size) throw new ComparisonError("save_unconfirmed");
      // Existing app privileges are SELECT/INSERT/DELETE on this table. Delete
      // RETURNING locks these exact rows; rollback restores them on any mismatch.
      const removed = await tx.delete(comparisonResults).where(and(eq(comparisonResults.caseId, caseId), inArray(comparisonResults.resultId, ids!))).returning();
      if (removed.length !== ids!.length || digest([...removed].sort((a,b)=>a.resultId-b.resultId)) !== digest([...ownRows].sort((a,b)=>a.resultId-b.resultId))) throw new ComparisonError("save_unconfirmed");
      await tx.insert(comparisonResults).values(removed.map(row => ({ ...row,
        matchedElementsJson: JSON.stringify({ matched: [], unmatched: [],
          explanation: `保存時点 ${saved.generatedAt} の指定比較です。原文・版・根拠は「根拠付き比較」で確認してください。現在の入力に対する結果とは限りません。`,
          priorArtComparison: saved }),
      })));
      return saved;
    });
  } catch (error) {
    if (saveStarted) {
      // Read back the operation after an uncertain COMMIT; never resend AI here.
      try {
        const saved = (await savedResults(db, caseId)).results.find(r => r.operationId === selection.operationId);
        if (saved && digest(saved.selection) === digest(selection)) return saved;
      } catch { /* Keep the uncertain state explicit. */ }
      if (error instanceof ComparisonError && error.code === "stale_input") throw error;
      throw new ComparisonError("save_unconfirmed");
    }
    if (error instanceof ComparisonError) throw error;
    throw new ComparisonError("save_unconfirmed");
  }
}
