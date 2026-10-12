import { createHash } from "node:crypto";
import { z } from "zod";
import { managedDate, validateManagedPeriod } from "../patent-watch/managed-period";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().refine(value => { try { managedDate(value); return true; } catch { return false; } });
const caseId = z.number().int().positive().max(2_147_483_647);
/** OWNER-signed description of actual parsed fictional bytes. Not HTTP input
 * and never an official distribution CSV or a claim about public coverage. */
export const trialFictionalManifestSchema = z.object({
  schema: z.literal(1), kind: z.literal("fictional_trial"), packageSha256: hash,
  period: z.object({ from: date, to: date }).strict(),
  issueNumber: z.string().regex(/^\d{4}-\d{3}$/), cumulativeIssue: z.string().regex(/^\d{5}$/),
  publicationDate: date, publishedCount: z.number().int().min(0).max(5), translatedCount: z.number().int().min(0).max(5),
  records: z.array(z.object({ caseId, originalXmlSha256: hash, sourceKey: hash,
    publicationDate: date, kind: z.enum(["A1", "P1"]) }).strict()).min(1).max(5),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: "custom", message: "fictional_manifest_unconfirmed" });
  try { validateManagedPeriod(value.period); } catch { invalid(); }
  if (value.publicationDate < value.period.from || value.publicationDate > value.period.to ||
      value.records.some(row => row.publicationDate !== value.publicationDate) ||
      value.records.filter(row => row.kind === "A1").length !== value.publishedCount ||
      value.records.filter(row => row.kind === "P1").length !== value.translatedCount) invalid();
  for (const key of ["caseId", "originalXmlSha256", "sourceKey"] as const)
    if (new Set(value.records.map(row => row[key])).size !== value.records.length) invalid();
});
export type TrialFictionalManifest = z.infer<typeof trialFictionalManifestSchema>;
export const TRIAL_FICTIONAL_SOURCE = "urn:patentai:trial:fictional-distribution:v1";
export const trialFictionalBytes = (value: TrialFictionalManifest) => Buffer.from(JSON.stringify(trialFictionalManifestSchema.parse(value)));
export const trialFictionalDigest = (value: TrialFictionalManifest) => createHash("sha256").update(trialFictionalBytes(value)).digest("hex");
