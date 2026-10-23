import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { cases, comparisonResults, draftPatents, priorArtDocuments } from "@/db/schema";
import { lockManagedCase } from "@/repositories/managed-case-graph";
import { ComparisonError, digest, parseComparisonSource, type SourceSnapshot } from "./source";
import { executeComparison, PROPOSITION_GENERATION_SYSTEM } from "./execute";
import { ComparisonExecutionError, type ComparisonStage } from "./failure";
import { separatedGenerationPlan } from "./source-separation";
import { assertPropositionPlan } from "./proposition-plan";

import { validateSourceAudit, type SourceAudit } from "./source-audit";
import { sourceClaimExtractionPlan } from "./source-claim-extraction";

type KnownFailure = { stage: ComparisonStage; kind: "protocol_invalid" | "review_rejected" | "output_incomplete" };
const reservationCapabilities = new WeakMap<object, { caseId: number; selectionHash: string; reservationHash: string }>();
function knownFailure(error: unknown): KnownFailure | null {
  return error instanceof ComparisonExecutionError && ["protocol_invalid", "review_rejected", "output_incomplete"].includes(error.kind)
    ? { stage: error.stage, kind: error.kind as KnownFailure["kind"] } : null;
}
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
  const failedOperations: { operationId: string; failure: KnownFailure }[] = [];
  for (const operationId of reserved) {
    const own = rows.filter(row => (envelope(row) as { operationId?: string } | null)?.operationId === operationId);
    const marker = envelope(own[0]) as { selection?: Selection; failure?: KnownFailure };
    const rawFailure = marker.failure;
    if (!rawFailure || !["source_reading", "generation", "review"].includes(rawFailure.stage) ||
        !["protocol_invalid", "review_rejected", "output_incomplete"].includes(rawFailure.kind) || !marker.selection) continue;
    const failure: KnownFailure = { stage: rawFailure.stage, kind: rawFailure.kind };
    try {
      const expected = new Set(marker.selection.documents.flatMap(d => marker.selection!.draftClaimNos.map(n => `${n}:${d.docId}`)));
      const exact = { version: 1, status: "reserved", operationId, selection: marker.selection, failure };
      if (own.length === expected.size && own.every(row => row.caseId === caseId && digest(envelope(row)) === digest(exact) &&
          expected.delete(`${row.draftClaimId}:${row.priorDocId}`)) && !expected.size) failedOperations.push({ operationId, failure });
    } catch { /* An inconsistent failure marker remains unconfirmed, never retried. */ }
  }
  return { results: results.sort((a,b) => b.generatedAt.localeCompare(a.generatedAt)), legacyCount, invalidCount, reservedCount: reserved.size, pendingOperationIds: [...reserved], failedOperations };
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
export async function reserveComparison(caseId: number, selection: Selection) {
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
      const sameReservation = await tx.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
      const ownPending = sameReservation.filter(row => {
        const value = envelope(row) as { status?: string; operationId?: string } | null;
        return value?.status === "reserved" && value.operationId === selection.operationId;
      });
      if (ownPending.length) {
        if (ownPending.some(row => digest((envelope(row) as { selection?: unknown }).selection) !== digest(selection))) throw new ComparisonError("selection_invalid");
        return { pending: true as const };
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
      assertPropositionPlan(separatedGenerationPlan(makePlan(inputs, selection), PROPOSITION_GENERATION_SYSTEM));
      const groups = selection.documents.flatMap(d => selection.draftClaimNos.map(claimNo => ({ docId: d.docId, claimNo })));
      const reservedRows = await tx.insert(comparisonResults).values(groups.map(p => ({ caseId, draftClaimId: String(p.claimNo), priorDocId: p.docId,
        matchedElementsJson: JSON.stringify({ matched: [], unmatched: [], explanation: "完了未確認の指定比較です。再実行せず保存結果を照合してください。",
          priorArtComparison: { version: 1, status: "reserved", operationId: selection.operationId, selection } }),
      }))).returning({ id: comparisonResults.resultId });
      return { inputs, ids: reservedRows.map(r => r.id) };
    });
    if (reservation.inputs) reservationCapabilities.set(reservation, { caseId, selectionHash: digest(selection), reservationHash: digest(reservation) });
    return reservation;
}

type Reservation = Awaited<ReturnType<typeof reserveComparison>>;
/** Only the callback holding a newly committed reservation may dispatch. */
export async function completeReservedComparison(caseId: number, selection: Selection, reservation: Reservation) {
  if (reservation.existing) return reservation.existing;
  if (reservation.pending) throw new ComparisonError("save_unconfirmed");
  const capability = reservationCapabilities.get(reservation);
  reservationCapabilities.delete(reservation);
  if (!capability || capability.caseId !== caseId || capability.selectionHash !== digest(selection) || capability.reservationHash !== digest(reservation)) throw new ComparisonError("save_unconfirmed");
  let saveStarted = false;
  try {
    const { inputs, ids } = reservation;
    const tasks = sourceClaimExtractionPlan(separatedGenerationPlan(makePlan(inputs!, selection), PROPOSITION_GENERATION_SYSTEM)).tasks;
    const saved = await executeComparison(inputs!, selection, async audit => {
      await recordSourceAudit(caseId, selection, ids!, validateSourceAudit(audit, selection.operationId, inputs!.inputDigest, tasks.map(({ id, sourceIndex, sourceDigest, claimNo }) => ({ id, sourceIndex, sourceDigest, claimNo }))));
    });
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
      if (new Set(ownRows.map(row => digest(auditProperty(row)))).size !== 1) throw new ComparisonError("save_unconfirmed");
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
          priorArtComparison: saved, ...auditProperty(row) }),
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
    const failure = knownFailure(error);
    if (failure) {
      try { await recordReservedFailure(caseId, selection, reservation.ids!, failure); }
      catch { /* Unknown write ACK remains a durable unconfirmed reservation. */ }
    }
    if (error instanceof ComparisonError) throw error;
    throw new ComparisonError("save_unconfirmed");
  }
}

async function recordReservedFailure(caseId: number, selection: Selection, ids: number[], failure: KnownFailure) {
  await db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await lockManagedCase(tx, caseId);
    const rows = await tx.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
    const own = rows.filter(row => (envelope(row) as { operationId?: string } | null)?.operationId === selection.operationId);
    const expected = new Set(selection.documents.flatMap(d => selection.draftClaimNos.map(n => `${n}:${d.docId}`)));
    const marker = { version: 1, status: "reserved", operationId: selection.operationId, selection };
    if (new Set(own.map(row => digest(auditProperty(row)))).size !== 1) throw new ComparisonError("save_unconfirmed");
    if (own.length !== ids.length || own.some(row => !ids.includes(row.resultId) || digest(envelope(row)) !== digest(marker) ||
        !expected.delete(`${row.draftClaimId}:${row.priorDocId}`)) || expected.size) throw new ComparisonError("save_unconfirmed");
    const removed = await tx.delete(comparisonResults).where(and(eq(comparisonResults.caseId, caseId), inArray(comparisonResults.resultId, ids))).returning();
    if (removed.length !== ids.length || digest([...removed].sort((a,b)=>a.resultId-b.resultId)) !== digest([...own].sort((a,b)=>a.resultId-b.resultId))) throw new ComparisonError("save_unconfirmed");
    await tx.insert(comparisonResults).values(removed.map(row => ({ ...row,
      matchedElementsJson: JSON.stringify({ matched: [], unmatched: [], explanation: "品質検証で停止しました。予約を保持し、自動再送しません。", priorArtComparison: { ...marker, failure }, ...auditProperty(row) }),
    })));
  });
}

/** Synchronous adapter retained for isolated diagnostics; HTTP uses after(). */
export async function runAndSaveComparison(caseId: number, selection: Selection) {
  return completeReservedComparison(caseId, selection, await reserveComparison(caseId, selection));
}

// Private sidecar is outside saved-v1, so report formats and snapshot digests stay unchanged.
function auditProperty(row: ResultRow): { priorArtComparisonSourceAudit?: SourceAudit } {
  const outer = JSON.parse(row.matchedElementsJson ?? "null");
  const value = outer?.priorArtComparisonSourceAudit;
  if (value === undefined) return {};
  const marker = outer.priorArtComparison;
  return { priorArtComparisonSourceAudit: validateSourceAudit(value, marker.operationId,
    marker.status === "reserved" ? marker.selection.inputDigest : marker.inputs.inputDigest) };
}
async function recordSourceAudit(caseId: number, selection: Selection, ids: number[], audit: SourceAudit) {
  await db.transaction(async tx => {
    await tx.execute(sql`set local lock_timeout = '3s'`);
    await lockManagedCase(tx, caseId);
    const rows = await tx.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
    const own = rows.filter(row => (envelope(row) as { operationId?: string } | null)?.operationId === selection.operationId);
    const expected = new Set(selection.documents.flatMap(d => selection.draftClaimNos.map(n => `${n}:${d.docId}`)));
    const marker = { version: 1, status: "reserved", operationId: selection.operationId, selection };
    if (new Set(own.map(row => digest(auditProperty(row)))).size !== 1) throw new ComparisonError("save_unconfirmed");
    if (own.length !== ids.length || own.some(row => !ids.includes(row.resultId) || digest(envelope(row)) !== digest(marker) ||
        Object.keys(auditProperty(row)).length || !expected.delete(`${row.draftClaimId}:${row.priorDocId}`)) || expected.size) throw new ComparisonError("save_unconfirmed");
    const removed = await tx.delete(comparisonResults).where(and(eq(comparisonResults.caseId, caseId), inArray(comparisonResults.resultId, ids))).returning();
    if (removed.length !== ids.length || digest([...removed].sort((a,b)=>a.resultId-b.resultId)) !== digest([...own].sort((a,b)=>a.resultId-b.resultId))) throw new ComparisonError("save_unconfirmed");
    await tx.insert(comparisonResults).values(removed.map(row => ({ ...row,
      matchedElementsJson: JSON.stringify({ ...JSON.parse(row.matchedElementsJson!), priorArtComparisonSourceAudit: audit }),
    })));
  });
}
export async function getComparisonSourceAudit(caseId: number, operationId: string) {
  const rows = await db.select().from(comparisonResults).where(eq(comparisonResults.caseId, caseId));
  const own = rows.filter(row => (envelope(row) as { operationId?: string } | null)?.operationId === operationId);
  if (!own.length) throw new ComparisonError("not_found");
  const first = envelope(own[0]) as { status: string; selection: Selection };
  const selection = first.selection;
  if (!selection || selection.operationId !== operationId) throw new ComparisonError("result_invalid");
  const expected = new Set(selection.documents.flatMap(d => selection.draftClaimNos.map(n => `${n}:${d.docId}`)));
  const audit = auditProperty(own[0]).priorArtComparisonSourceAudit;
  if (!audit) throw new ComparisonError("not_found");
  if (first.status === "complete") {
    const saved = validateSaved(first);
    if (saved.inputs.caseId !== caseId) throw new ComparisonError("result_invalid");
    const tasks = sourceClaimExtractionPlan(separatedGenerationPlan(makePlan(saved.inputs, saved.selection), PROPOSITION_GENERATION_SYSTEM)).tasks;
    validateSourceAudit(audit, operationId, saved.inputs.inputDigest, tasks.map(({id,sourceIndex,sourceDigest,claimNo}) => ({id,sourceIndex,sourceDigest,claimNo})));
  } else if (first.status !== "reserved") throw new ComparisonError("result_invalid");
  // Pending markers contain no original snapshot. Their roster is checked at
  // the write boundary; reads enforce identity grammar/digest/exact owned rows.
  if (own.length !== expected.size || own.some(row => row.caseId !== caseId || digest(envelope(row)) !== digest(first) ||
      digest(auditProperty(row)) !== digest({ priorArtComparisonSourceAudit: audit }) ||
      !expected.delete(`${row.draftClaimId}:${row.priorDocId ?? JSON.parse(row.matchedElementsJson!).detachedPriorDocId}`)) || expected.size) throw new ComparisonError("result_invalid");
  return audit;
}
