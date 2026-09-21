import { z } from "zod";
import { MANUAL_MAX_BYTES } from "./manual-cli-config";
import { MANUAL_RECEIPT_BYTES, MANUAL_RECEIPT_RECORD_BYTES } from "./manual-cli-receipt";
import { updateDate } from "./update-check-config";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const ordinal = z.number().int().min(1).max(64);
const packageType = z.enum(["JPA", "JPB"]);
const cleanup = z.enum(["complete", "required"]);
const outcomes = z.enum(["preview_not_saved", "inserted", "reused", "review_not_saved",
  "failed_before_save", "save_outcome_unknown", "not_processed"]);
const issues = z.object({ reviewRequired: count, unsupported: count, failed: count }).strict();
const summary = z.object({
  packageStatus: z.enum(["success", "review_required", "failed"]), documentCount: count,
  reviewDocumentCount: count, amendmentCount: count, attachmentCount: count, nestedSt26Count: count,
  review: z.object({ packageIssues: issues, xmlIssues: issues, unprocessedEntries: count }).strict(),
  publicationDates: z.object({ scope: z.literal("input_publications_only"), min: updateDate.nullable(), max: updateDate.nullable() }).strict(),
}).strict().refine(s => s.reviewDocumentCount <= s.documentCount &&
  (s.documentCount === 0 ? s.publicationDates.min === null && s.publicationDates.max === null :
    s.publicationDates.min !== null && s.publicationDates.max !== null && s.publicationDates.min <= s.publicationDates.max));
const common = { schemaVersion: z.literal(1), operationId: z.uuidv4(), sequence: count,
  observedAt: z.string().refine(s => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s) &&
    Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s) };
const bindingSchema = z.object({ ordinal, packageType, byteLength: z.number().int().positive().max(MANUAL_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const record = z.discriminatedUnion("type", [
  z.object({ ...common, type: z.literal("batch_started"), mode: z.enum(["preview", "apply"]),
    fileCount: z.number().int().min(1).max(64), files: z.array(z.object({ ordinal, packageType }).strict()).min(1).max(64) }).strict(),
  z.object({ ...common, type: z.literal("input_verified"), ...bindingSchema.shape }).strict(),
  z.object({ ...common, type: z.literal("file_finished"), ordinal, packageType, outcome: outcomes,
    savedDocumentCount: count, includesReviewRequired: z.boolean(), cleanup, summary: summary.optional() }).strict(),
  z.object({ ...common, type: z.literal("batch_finished"), status: z.enum(["complete", "stopped", "reconciliation_required"]),
    cleanup, savedRecordCount: count }).strict(),
]);
type ReceiptRecord = z.infer<typeof record>;
export type ReceiptEntry = {
  ordinal: number; packageType: "JPA" | "JPB"; binding?: z.infer<typeof bindingSchema>;
  result?: Extract<ReceiptRecord, { type: "file_finished" }>;
};
export type UpdateReceipt = {
  structuralComplete: boolean; endAcknowledgement: "unconfirmed"; invalid: boolean;
  entries: ReceiptEntry[]; cleanup: "complete" | "required" | "unconfirmed";
};

/** Keep the validated prefix. A footer is never a sync/close acknowledgement or a DB check. */
export function readUpdateReceipt(bytes: Uint8Array): UpdateReceipt {
  const result: UpdateReceipt = { structuralComplete: false, endAcknowledgement: "unconfirmed",
    invalid: false, entries: [], cleanup: "unconfirmed" };
  let start: Extract<ReceiptRecord, { type: "batch_started" }> | undefined;
  let sequence = 0, finished = 0, saved = 0, processingStopped = false, failureSeen = false;
  try {
    if (bytes.byteLength > MANUAL_RECEIPT_BYTES) throw Error();
    let offset = 0;
    while (offset < bytes.length) {
      const end = bytes.indexOf(10, offset);
      if (end < 0 || end - offset + 1 > MANUAL_RECEIPT_RECORD_BYTES || sequence >= 130 || result.structuralComplete) throw Error();
      const line = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(offset, end));
      offset = end + 1;
      const r = record.parse(JSON.parse(line));
      if (r.sequence !== sequence + 1 || (start && r.operationId !== start.operationId)) throw Error();
      if (!start) {
        if (r.type !== "batch_started" || r.fileCount !== r.files.length || r.files.some((f, n) => f.ordinal !== n + 1)) throw Error();
        start = r; result.entries = r.files.map(f => ({ ...f }));
      } else if (r.type === "input_verified" || r.type === "file_finished") {
        const entry = result.entries[finished];
        if (!entry || r.ordinal !== entry.ordinal || r.packageType !== entry.packageType) throw Error();
        if (r.type === "input_verified") {
          if (entry.binding || processingStopped) throw Error();
          entry.binding = bindingSchema.parse({ ordinal: r.ordinal, packageType: r.packageType, byteLength: r.byteLength, sha256: r.sha256 });
        } else {
          const isSaved = r.outcome === "inserted" || r.outcome === "reused";
          if ((r.summary && !entry.binding) || (!isSaved && (r.savedDocumentCount !== 0 || r.includesReviewRequired)) ||
            (failureSeen && r.outcome !== "not_processed") ||
            (processingStopped && !["not_processed", "failed_before_save"].includes(r.outcome)) ||
            (start.mode === "preview" && !["preview_not_saved", "failed_before_save", "not_processed"].includes(r.outcome)) ||
            (start.mode === "apply" && r.outcome === "preview_not_saved") ||
            ((isSaved || r.outcome === "preview_not_saved" || r.outcome === "review_not_saved") && (!entry.binding || !r.summary)) ||
            ((isSaved || r.outcome === "preview_not_saved") && r.summary?.packageStatus === "failed") ||
            (r.outcome === "review_not_saved" && r.summary?.packageStatus !== "review_required") ||
            (isSaved && (r.summary!.documentCount !== r.savedDocumentCount ||
              r.includesReviewRequired !== (r.summary!.packageStatus === "review_required")))) throw Error();
          entry.result = r; finished++;
          if (!["inserted", "reused", "preview_not_saved"].includes(r.outcome) || r.cleanup === "required") processingStopped = true;
          if (["failed_before_save", "review_not_saved", "save_outcome_unknown"].includes(r.outcome) || r.cleanup === "required") failureSeen = true;
          if (r.outcome === "inserted") saved += r.savedDocumentCount;
          if (r.cleanup === "required") result.cleanup = "required";
        }
      } else if (r.type === "batch_finished") {
        const unknown = result.entries.some(e => e.result?.outcome === "save_outcome_unknown");
        const failed = result.entries.some(e => !["preview_not_saved", "inserted", "reused"].includes(e.result?.outcome ?? ""));
        if (finished !== start.fileCount || r.savedRecordCount !== saved ||
          (unknown ? r.status !== "reconciliation_required" : r.status === "reconciliation_required") ||
          ((failed || result.cleanup === "required" || r.cleanup === "required") && r.status === "complete") ||
          (result.cleanup === "required" && r.cleanup !== "required")) throw Error();
        result.cleanup = r.cleanup; result.structuralComplete = true;
      } else throw Error();
      sequence++;
    }
    if (!start) throw Error();
  } catch { result.invalid = true; result.structuralComplete = false; }
  return result;
}
