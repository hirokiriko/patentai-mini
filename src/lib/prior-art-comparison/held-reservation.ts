import { z } from "zod";
import { selectionSchema, type Selection } from "./comparison";
import { ComparisonError, digest } from "./source";
import { validateSourceAudit } from "./source-audit";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const heldEvidenceSchema = z.object({
  schema: z.literal("CASE104_HELD_UNKNOWN_RESERVATION_EVIDENCE_V1"), caseId: z.literal(104),
  operationId: z.uuid(), selectionSHA256: hash,
  rows: z.array(z.object({ resultId: z.number().int().positive(), draftClaimId: z.string(),
    priorDocId: z.number().int().positive(), rowSHA256: hash, markerSHA256: hash,
    auditDigest: hash.nullable() }).strict()).length(2), evidenceDigest: hash,
}).strict();
export type HeldEvidence = z.infer<typeof heldEvidenceSchema>;
export type HeldRow = { resultId?: number; caseId: number; draftClaimId: string | null;
  priorDocId: number | null; matchedElementsJson: string | null };
export type HeldReference = { operationId: string; selection: Selection; selectionSHA256: string };

/** Fingerprints only: no row content, source text or credentials leave this boundary. */
export function heldReservationEvidence(rows: HeldRow[], reference: HeldReference): HeldEvidence {
  const selection = selectionSchema.parse(reference.selection);
  if (selection.operationId !== reference.operationId || digest(selection) !== reference.selectionSHA256 ||
      selection.draftClaimNos.length !== 1 || selection.documents.length !== 2 ||
      selection.documents.some(doc => doc.claimNos.length !== 1)) throw new ComparisonError("result_invalid");
  const own = rows.filter(row => {
    try { return JSON.parse(row.matchedElementsJson ?? "null")?.priorArtComparison?.operationId === reference.operationId; }
    catch { throw new ComparisonError("result_invalid"); }
  });
  if (own.length !== 2) throw new ComparisonError("save_unconfirmed");
  const keys = new Set(selection.documents.map(doc => `${selection.draftClaimNos[0]}:${doc.docId}`));
  const entries = own.map(row => {
    const outer = JSON.parse(row.matchedElementsJson ?? "null"), marker = outer.priorArtComparison;
    const expected = { version: 1, status: "reserved", operationId: reference.operationId, selection };
    if (row.caseId !== 104 || !Number.isSafeInteger(row.resultId) || row.resultId! <= 0 ||
        typeof row.matchedElementsJson !== "string" || digest(marker) !== digest(expected) ||
        !keys.delete(`${row.draftClaimId}:${row.priorDocId}`)) throw new ComparisonError("result_invalid");
    const audit = outer.priorArtComparisonSourceAudit === undefined ? null :
      validateSourceAudit(outer.priorArtComparisonSourceAudit, reference.operationId, selection.inputDigest).auditDigest;
    return { resultId: row.resultId!, draftClaimId: row.draftClaimId!, priorDocId: row.priorDocId!,
      rowSHA256: digest({ resultId: row.resultId, caseId: row.caseId, draftClaimId: row.draftClaimId,
        priorDocId: row.priorDocId, matchedElementsJson: row.matchedElementsJson }), markerSHA256: digest(marker), auditDigest: audit };
  }).sort((a, b) => a.resultId - b.resultId);
  if (keys.size || new Set(entries.map(row => row.resultId)).size !== 2 ||
      new Set(entries.map(row => row.auditDigest)).size !== 1) throw new ComparisonError("result_invalid");
  const value = { schema: "CASE104_HELD_UNKNOWN_RESERVATION_EVIDENCE_V1" as const, caseId: 104 as const,
    operationId: reference.operationId, selectionSHA256: reference.selectionSHA256, rows: entries };
  return heldEvidenceSchema.parse({ ...value, evidenceDigest: digest(value) });
}
