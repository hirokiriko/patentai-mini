import { z } from "zod";
import { resolve } from "node:path";
import { validCompactDate } from "../koho-distribution-table";
import { MANUAL_MAX_BYTES, requireManualFilePath } from "./manual-cli-config";

const path = z.string().superRefine((value, ctx) => {
  try { requireManualFilePath(value); } catch { ctx.addIssue({ code: "custom", message: "invalid_path" }); }
});
export const updateDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(value => validCompactDate(value.replaceAll("-", "")));
const file = z.object({ packageType: z.enum(["JPA", "JPB"]), path }).strict();
const bytes = z.number().int().positive().max(MANUAL_MAX_BYTES);
const schema = z.object({
  period: z.object({ from: updateDate, to: updateDate }).strict().refine(x => x.from <= x.to),
  distributionTables: z.array(file).max(2).refine(x => new Set(x.map(f => f.packageType)).size === x.length),
  packages: z.array(file).max(64), receipts: z.array(z.object({ path }).strict()).max(64).default([]),
  maxFileBytes: bytes, maxTotalBytes: bytes,
  output: z.object({ path, privateDirectoryConfirmed: z.literal(true) }).strict(),
}).strict().refine(x => {
  const normalized = (p: string) => process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return [...x.distributionTables, ...x.packages, ...x.receipts].every(f => normalized(f.path) !== normalized(x.output.path));
});
export type UpdateConfiguration = z.infer<typeof schema>;
export function parseUpdateConfiguration(input: unknown): UpdateConfiguration { return schema.parse(input); }

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const aggregate = z.object({ status: z.enum(["checked", "incomplete"]), coverageProven: z.literal(false),
  productionState: z.literal("unconfirmed"), attentionRequired: z.literal(true), exitCode: z.union([z.literal(0), z.literal(2)]),
  counts: z.object({ targetRows: count, missingFiles: count, unavailableRows: count, missingTables: count, zeroRowTables: count,
    tableWarnings: count, suppliedPackages: count, unmatchedPackages: count, duplicateFiles: count, conflictingRows: count,
    receiptFiles: count, incompleteReceipts: count, unmatchedReceiptRecords: count, unknownReceiptRecords: count,
    recordedInserted: count, recordedReused: count, recordedPreviews: count, processingErrors: count }).strict(),
}).strict().refine(x => x.counts.processingErrors === 0 ? x.status === "checked" && x.exitCode === 0 : x.status === "incomplete" && x.exitCode === 2);
/** Validate the private worker boundary before anything is projected onto stdout. */
export const projectUpdateAggregate = (value: unknown) => aggregate.parse(value);
