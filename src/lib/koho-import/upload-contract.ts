import { z } from "zod";
import { managedCloudConfigSchema } from "../patent-watch/managed-cloud-config";
import { managedBudgetBindingSchema, managedBudgetReferenceSchema, managedExecutionApprovalSchema } from "../patent-watch/managed-budget-contract";
import { cloudTargetSchema, cloudEnvironmentResourceIdSchema } from "./cloud-config";

export const KOHO_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const KOHO_UPLOAD_MAX_BYTES = 8 * 1024 ** 3;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(250_000);
export const kohoUploadFileSchema = z.object({
  fileName: z.string().min(5).max(200).regex(/^[^\\/:\u0000-\u001f\u007f]+\.zip$/i),
  byteLength: z.number().int().positive().max(KOHO_UPLOAD_MAX_BYTES),
}).strict();
export const kohoUploadCreateSchema = kohoUploadFileSchema.extend({ operationId: z.uuidv4(), requestedAt: z.iso.datetime(), sourceAcquiredAt: z.iso.datetime().nullable() }).strict();

/** Installed server settings, never HTTP input. No keys, URLs, or DB passwords. */
export const kohoUploadSettingsSchema = z.object({
  approval: managedExecutionApprovalSchema,
  codeSha: managedCloudConfigSchema.shape.codeSha,
  job: z.object({ resourceId: managedCloudConfigSchema.shape.jobResourceId, name: managedCloudConfigSchema.shape.jobName,
    image: managedCloudConfigSchema.shape.image, databaseSecretRef: z.string().regex(/^[a-z0-9-]{1,64}$/) }).strict(),
  environmentResourceId: cloudEnvironmentResourceIdSchema, target: cloudTargetSchema,
  budgetBinding: managedBudgetBindingSchema,
  maxBytes: z.number().int().positive().max(KOHO_UPLOAD_MAX_BYTES),
  maxDatabaseBytes: z.number().int().positive().max(1024 ** 5),
  reservedGrowthBytes: z.number().int().positive().max(1024 ** 5),
}).strict().refine(c => c.job.resourceId.endsWith(`/jobs/${c.job.name}`) && c.reservedGrowthBytes < c.maxDatabaseBytes);
export type KohoUploadSettings = z.infer<typeof kohoUploadSettingsSchema>;
export const kohoUploadIntentSchema = z.object({ schema: z.literal(1), settings: kohoUploadSettingsSchema,
  operationId: z.uuidv4(), file: kohoUploadFileSchema, receivedAt: z.iso.datetime(), sourceAcquiredAt: z.iso.datetime().nullable(), expiresAt: z.iso.datetime(),
  serviceBudget: managedBudgetReferenceSchema.optional(),
}).strict().refine(c => c.file.byteLength <= c.settings.maxBytes && Date.parse(c.expiresAt) > Date.parse(c.receivedAt) &&
  Date.parse(c.expiresAt) - Date.parse(c.receivedAt) <= 6 * 60 * 60_000 &&
  (c.sourceAcquiredAt === null || Date.parse(c.sourceAcquiredAt) <= Date.parse(c.receivedAt)));
export type KohoUploadIntent = z.infer<typeof kohoUploadIntentSchema>;
export const kohoUploadChunkSchema = z.object({ index: z.number().int().min(0).max(2047), sha256: digest,
  byteLength: z.number().int().positive().max(KOHO_UPLOAD_CHUNK_BYTES) }).strict();
export const kohoUploadStateSchema = z.object({ schema: z.literal(1), intent: kohoUploadIntentSchema,
  status: z.enum(["preparing", "uploading", "uploaded", "submitting", "processing", "complete", "failed", "outcome_unknown"]),
  chunks: z.array(kohoUploadChunkSchema).max(2048), pendingChunk: kohoUploadChunkSchema.nullable(),
  source: z.object({ etag: z.string().min(1).max(200), byteLength: z.number().int().positive().max(KOHO_UPLOAD_MAX_BYTES),
    blockListDigest: digest }).strict().nullable(),
  sealStarted: z.boolean(), startClaimed: z.boolean(), executionId: z.string().regex(/^[a-z0-9-]{1,100}$/).nullable(),
  result: z.object({ disposition: z.enum(["inserted", "reused"]), documentCount: count, completeClaims: count,
    incompleteClaims: count, publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), issueNumber: z.string().regex(/^\d{4}-\d{1,4}$/),
    receiptSha256: digest }).strict().nullable(),
  error: z.enum(["upload_incomplete", "verification_failed", "import_failed", "outcome_unknown", "expired"]).nullable(),
}).strict().superRefine((s, ctx) => {
  const fileBytes = s.intent.file.byteLength;
  if (s.chunks.some((c, i) => c.index !== i || c.byteLength !== Math.min(KOHO_UPLOAD_CHUNK_BYTES, fileBytes - i * KOHO_UPLOAD_CHUNK_BYTES)) ||
    s.chunks.reduce((n, c) => n + c.byteLength, 0) > fileBytes ||
    (s.pendingChunk && (s.pendingChunk.index !== s.chunks.length ||
      s.pendingChunk.byteLength !== Math.min(KOHO_UPLOAD_CHUNK_BYTES, fileBytes - s.pendingChunk.index * KOHO_UPLOAD_CHUNK_BYTES))) ||
    (s.source && (s.source.byteLength !== fileBytes || s.chunks.reduce((n, c) => n + c.byteLength, 0) !== fileBytes || s.pendingChunk)) ||
    (s.status === "complete" && (!s.result || !s.source || !s.startClaimed)) ||
    (s.result && s.result.completeClaims + s.result.incompleteClaims !== s.result.documentCount))
    ctx.addIssue({ code: "custom", message: "koho_upload_state_invalid" });
});
export type KohoUploadState = z.infer<typeof kohoUploadStateSchema>;
export const kohoUploadPrefix = (id: string) => `managed-koho-uploads/${z.uuidv4().parse(id)}/`;
export function kohoUploadBlockId(index: number, sha256: string) {
  kohoUploadChunkSchema.shape.index.parse(index); digest.parse(sha256);
  const bytes = Buffer.alloc(36); bytes.writeUInt32BE(index, 0); Buffer.from(sha256, "hex").copy(bytes, 4);
  return bytes.toString("base64");
}
/** Stable browser response; never expose source hashes, storage/DB/ARM settings or receipts. */
export function publicKohoUpload(s: KohoUploadState) {
  const v = kohoUploadStateSchema.parse(s);
  return { operationId: v.intent.operationId, ...v.intent.file, status: v.status, expiresAt: v.intent.expiresAt,
    requestedAt: v.intent.receivedAt, sourceAcquiredAt: v.intent.sourceAcquiredAt,
    uploadedBytes: v.chunks.reduce((n, c) => n + c.byteLength, 0), chunkBytes: KOHO_UPLOAD_CHUNK_BYTES,
    pending: v.pendingChunk !== null, error: v.error,
    result: v.result ? { disposition: v.result.disposition, documentCount: v.result.documentCount,
      completeClaims: v.result.completeClaims, incompleteClaims: v.result.incompleteClaims,
      publicationDate: v.result.publicationDate, issueNumber: v.result.issueNumber } : null };
}
export type PublicKohoUpload = ReturnType<typeof publicKohoUpload>;
