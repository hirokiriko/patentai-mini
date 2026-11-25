import { z } from "zod";
import { selectionSchema, validateSaved, type Selection, type SavedComparison } from "./comparison";
import { ComparisonError, digest } from "./source";
import { validateSourceAudit } from "./source-audit";
import type { ComparisonSpendAllocation } from "../ai-operation-budget";

export const LIMITED_RELEASE_ENV = "PRIOR_ART_COMPARISON_CASE104_RELEASE";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const releaseSchema = z.object({ schema: z.literal("CASE104_LIMITED_RELEASE_V1"), caseId: z.literal(104),
  phase: z.enum(["dev", "day"]), activeOperationId: z.uuid(), devOperationId: z.uuid(),
  validFromUTC: z.iso.datetime(), validUntilUTC: z.iso.datetime(),
  authority: z.object({ sequence: z.literal(168), envelopeSHA256: hash, ownerDecisionSHA256: hash }).strict(),
  scope: selectionSchema.omit({ operationId: true }),
  oldFailure: z.object({ operationId: z.uuid(), selectionSHA256: hash, auditDigest: hash,
    stage: z.enum(["source_reading", "generation", "review"]), kind: z.enum(["protocol_invalid", "review_rejected", "output_incomplete"]) }).strict(),
  budget: z.object({ maximumSends: z.literal(8), maximumJPY: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    inputYenPer100k: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), outputYenPer100k: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
  devSavedSnapshotDigest: hash.optional(),
}).strict();
export type LimitedRelease = z.infer<typeof releaseSchema>;
export type Admission = { restricted: boolean; operationId: string | null; canStart: boolean };
export function readLimitedRelease(now = Date.now()): { configured: boolean; value: LimitedRelease | null; sha256?: string } {
  const raw = process.env[LIMITED_RELEASE_ENV];
  if (raw === undefined) return { configured: false, value: null };
  try {
    if (!raw.length || Buffer.byteLength(raw) > 16384) throw Error();
    const value = releaseSchema.parse(JSON.parse(raw));
    if (Date.parse(value.validFromUTC) > now || now >= Date.parse(value.validUntilUTC) ||
      Date.parse(value.validFromUTC) >= Date.parse(value.validUntilUTC) ||
      value.oldFailure.operationId === value.activeOperationId || value.oldFailure.operationId === value.devOperationId ||
      value.scope.draftClaimNos.length !== 1 || value.scope.documents.length !== 2 || value.scope.documents.some(d => d.claimNos.length !== 1) ||
      (value.phase === "dev" ? value.activeOperationId !== value.devOperationId || value.devSavedSnapshotDigest !== undefined
        : value.activeOperationId === value.devOperationId || !value.devSavedSnapshotDigest)) throw Error();
    return { configured: true, value, sha256: digest(value) };
  } catch { return { configured: true, value: null }; }
}
export function assertReleaseSelection(release: LimitedRelease, caseId: number, selection: Selection) {
  const { operationId, ...scope } = selection;
  if (caseId !== 104 || operationId !== release.activeOperationId || digest(scope) !== digest(release.scope)) throw new ComparisonError("selection_invalid");
}
type Row = { caseId: number; draftClaimId: string | null; priorDocId: number | null; matchedElementsJson: string | null };
function record(row: Row): { marker: Record<string, unknown>; audit: unknown } {
  try { const value = JSON.parse(row.matchedElementsJson ?? "null");
    if (!value?.priorArtComparison || typeof value.priorArtComparison !== "object") throw Error();
    return { marker: value.priorArtComparison, audit: value.priorArtComparisonSourceAudit };
  } catch { throw new ComparisonError("result_invalid"); }
}
/** Exact old terminal evidence is retained, never changed/reclassified/released. */
export function assertReleaseHistory(release: LimitedRelease, rows: Row[], saved: SavedComparison[]) {
  const old = rows.filter(row => record(row).marker.operationId === release.oldFailure.operationId);
  if (!old.length) throw new ComparisonError("save_unconfirmed");
  const first = record(old[0]), selection = selectionSchema.parse(first.marker.selection);
  const failure = { stage: release.oldFailure.stage, kind: release.oldFailure.kind };
  const exact = { version: 1, status: "reserved", operationId: release.oldFailure.operationId, selection, failure };
  const { operationId: ignored, ...scope } = selection; void ignored;
  if (digest(selection) !== release.oldFailure.selectionSHA256 || digest(scope) !== digest(release.scope)) throw new ComparisonError("result_invalid");
  const keys = new Set(selection.documents.flatMap(d => selection.draftClaimNos.map(n => `${n}:${d.docId}`)));
  if (old.length !== keys.size) throw new ComparisonError("result_invalid");
  for (const row of old) {
    const own = record(row);
    if (!own.audit || !first.audit || row.caseId !== 104 || digest(own.marker) !== digest(exact) || !keys.delete(`${row.draftClaimId}:${row.priorDocId}`) || digest(own.audit) !== digest(first.audit)) throw new ComparisonError("result_invalid");
    const audit = validateSourceAudit(own.audit, release.oldFailure.operationId, selection.inputDigest);
    if (audit.auditDigest !== release.oldFailure.auditDigest) throw new ComparisonError("result_invalid");
  }
  if (keys.size) throw new ComparisonError("result_invalid");
  for (const row of rows) {
    const marker = record(row).marker;
    if (row.caseId !== 104 || ![release.oldFailure.operationId, release.activeOperationId, ...(release.phase === "day" ? [release.devOperationId] : [])].includes(String(marker.operationId))) throw new ComparisonError("save_unconfirmed");
    if (marker.status === "reserved" && marker.operationId !== release.oldFailure.operationId && marker.operationId !== release.activeOperationId) throw new ComparisonError("save_unconfirmed");
  }
  if (release.phase === "day") {
    const prior = saved.find(value => value.operationId === release.devOperationId);
    if (!prior) throw new ComparisonError("save_unconfirmed");
    const checked = validateSaved(prior), { operationId: ignoredDev, ...devScope } = checked.selection; void ignoredDev;
    if (checked.snapshotDigest !== release.devSavedSnapshotDigest || checked.inputs.caseId !== 104 || digest(devScope) !== digest(release.scope)) throw new ComparisonError("result_invalid");
  }
}
export function releaseAllocation(release: LimitedRelease, sha256: string): ComparisonSpendAllocation {
  return Object.freeze({ phase: release.phase, ...release.budget, releaseSHA256: sha256, validUntilUTC: release.validUntilUTC });
}
