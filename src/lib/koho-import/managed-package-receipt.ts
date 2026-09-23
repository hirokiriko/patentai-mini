import { z } from "zod";
import type { KohoPackageParseResult } from "../koho-package";
import type { KohoImportPlan } from "./types";
import { managedDate } from "../patent-watch/managed-period";
import { managedHash, ManagedWatchError } from "../patent-watch/managed-types";
import { updatePackageMetadata } from "./package-metadata";
import { managedCorrectionSchema, projectManagedCorrections } from "./managed-corrections";
import { managedDigest } from "../patent-watch/managed-claims";
export const managedPackageReceiptSchema = z.object({ schema: z.literal(1), sourceSha256: managedHash,
  publicationDate: z.string().refine(s => { try { managedDate(s); return true; } catch { return false; } }),
  issueNumber: z.string().regex(/^\d{4}-\d{3}$/), cumulativeIssue: z.string().regex(/^\d{5}$/),
  publishedCount: z.number().int().nonnegative(), translatedCount: z.number().int().nonnegative(),
  publishedAmendments: z.number().int().nonnegative(), translatedAmendments: z.number().int().nonnegative(),
  amendmentCount: z.number().int().nonnegative(), documentCount: z.number().int().nonnegative(),
  corrections: z.array(managedCorrectionSchema).max(10_000),
}).strict();
export type ManagedPackageReceipt = z.infer<typeof managedPackageReceiptSchema>;
export function validateManagedPackageReceipt(plan: KohoImportPlan, value: unknown) {
  const receipt = managedPackageReceiptSchema.parse(value);
  const counts = JSON.parse(plan.countsJson);
  if (plan.packageType !== "JPA" || plan.sourceSha256 !== receipt.sourceSha256 || plan.packageStatus === "failed" ||
    plan.documents.length !== receipt.documentCount || plan.amendmentCount !== receipt.amendmentCount ||
    plan.documents.filter(d => d.kind === "A1").length !== receipt.publishedCount || plan.documents.filter(d => d.kind === "P1").length !== receipt.translatedCount ||
    counts.bySection?.P_A5?.confirmedAmendments !== receipt.publishedAmendments || counts.bySection?.P_P5?.confirmedAmendments !== receipt.translatedAmendments ||
    receipt.amendmentCount !== receipt.publishedAmendments + receipt.translatedAmendments ||
    receipt.corrections.filter(c => c.kind === "A5").length !== receipt.publishedAmendments || receipt.corrections.filter(c => c.kind === "P5").length !== receipt.translatedAmendments ||
    receipt.corrections.some(c => { const { eventKey, ...identity } = c; return managedDigest(identity) !== eventKey; }) ||
    new Set(receipt.corrections.map(c => c.eventKey)).size !== receipt.corrections.length || Buffer.byteLength(JSON.stringify(receipt)) > 8*1024**2 ||
    plan.documents.some(d => d.publicationDate !== receipt.publicationDate || !["A1", "P1"].includes(d.kind))) throw new ManagedWatchError("incomplete");
  return receipt;
}
/** ABSTRACT, document-list and parsed primary documents must agree before persistence. */
export function projectManagedPackageReceipt(parsed: KohoPackageParseResult, plan: KohoImportPlan): ManagedPackageReceipt {
  const metadata = updatePackageMetadata(parsed);
  const records = parsed.csvResults.flatMap(c => c.result.logicalFile === "abstract" ? c.result.records : []);
  const abstracts = records.flatMap(r => r.semantic?.recordType === "metadata" ? [r.semantic] : []);
  if (abstracts.length !== 1 || metadata.notes.length || !metadata.date || !metadata.issue || parsed.packageType !== "JPA") throw new ManagedWatchError("incomplete");
  const summaries = records.flatMap(r => r.semantic?.recordType === "summary" ? [r.semantic] : []);
  const sectionCount = (section: "P_A1" | "P_P1" | "P_A5" | "P_P5") => {
    const matches = summaries.filter(s => s.section === section);
    if (matches.length > 1) throw new ManagedWatchError("incomplete");
    if (!matches.length) return 0;
    const value = matches[0].documentCount.value;
    if (!Number.isSafeInteger(value) || value < 0) throw new ManagedWatchError("incomplete");
    return value;
  };
  const receipt = validateManagedPackageReceipt(plan, { schema: 1, sourceSha256: plan.sourceSha256, publicationDate: metadata.date,
    issueNumber: metadata.issue, cumulativeIssue: abstracts[0].issueControlValue, publishedCount: sectionCount("P_A1"), translatedCount: sectionCount("P_P1"),
    publishedAmendments: sectionCount("P_A5"), translatedAmendments: sectionCount("P_P5"),
    amendmentCount: plan.amendmentCount, documentCount: plan.documentCount, corrections: projectManagedCorrections(parsed) });
  const sections = { P_A1: receipt.publishedCount, P_P1: receipt.translatedCount, P_A5: receipt.publishedAmendments, P_P5: receipt.translatedAmendments };
  const expected = receipt.documentCount + receipt.amendmentCount;
  if (parsed.counts.primaryXmlCandidates !== expected || parsed.counts.finalXmlResults !== expected || parsed.primaryXmlResults.length !== expected ||
    parsed.primaryXmlResults.some(item => !("identityConfirmed" in item.result) || !item.result.identityConfirmed ||
      !["full_publication", "amendment"].includes(item.result.entryType)) ||
    Object.entries(sections).some(([section, expected]) => {
      const c = parsed.counts.bySection[section as keyof typeof sections];
      return c.primaryXmlCandidates !== expected || c.finalXmlResults !== expected || c.confirmedFullPublications + c.confirmedAmendments !== expected;
    })) throw new ManagedWatchError("incomplete");
  return receipt;
}
