import { z } from "zod";
import { kohoUploadStateSchema } from "./upload-contract";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const uploadResultSchema = kohoUploadStateSchema.shape.result.unwrap().omit({ receiptSha256: true });
export const uploadArchiveSchema = z.object({ schema: z.literal(1), operationId: z.uuidv4(), packageType: z.literal("JPA"),
  source: kohoUploadStateSchema.shape.source.unwrap().extend({ blobName: z.string().max(200), sha256: hash }).strict(),
  publicationDate: uploadResultSchema.shape.publicationDate, issueNumber: uploadResultSchema.shape.issueNumber,
  distributionTableSha256: hash, receivedAt: z.iso.datetime(), sourceAcquiredAt: z.iso.datetime().nullable(),
  verifiedAt: z.iso.datetime(), codeSha: z.string().regex(/^[a-f0-9]{40}$/),
  planSha256: hash, managedSourcesSha256: hash, managedReceiptSha256: hash, documentCount: uploadResultSchema.shape.documentCount,
}).strict();
export const uploadFinishedSchema = z.object({ schema: z.literal(1), operationId: z.uuidv4(), intentDigest: hash,
  archiveDigest: hash, sourceSha256: hash, result: uploadResultSchema,
  databaseGrowthBytes: z.number().int().nonnegative(), managedReceiptSha256: hash, completedAt: z.iso.datetime(),
}).strict();
