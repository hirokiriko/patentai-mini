/** Offline, bounded preview. Only safe metadata/digests leave this process. */
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { parseKohoPackage } from "../src/lib/koho-package";
import { buildManagedImportLimits } from "../src/lib/koho-import/managed-limits";
import { verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";
import { buildKohoImportPlan } from "../src/lib/koho-import/builder";
import { cloudPlanSha256 } from "../src/lib/koho-import/cloud-config";
import { projectManagedPackage } from "../src/lib/koho-import/managed-package";
const input = z.object({ schema: z.literal(1), sourcePath: z.string().min(1).max(4096).refine(isAbsolute),
  byteLength: z.number().int().positive().max(8 * 1024**3), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export async function previewManagedKoho(value: unknown) {
  const started = performance.now();
  const config = input.parse(value), stat = await lstat(config.sourcePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== config.byteLength) throw Error();
  await verifyManualSnapshot(config.sourcePath, config.byteLength, config.sha256);
  const parsed = await parseKohoPackage({ packageType: "JPA", source: { type: "file", path: config.sourcePath }, limits: buildManagedImportLimits(config.byteLength) });
  const plan = buildKohoImportPlan({ packageResult: parsed, sourceSha256: config.sha256 }), managed = projectManagedPackage(parsed, plan);
  await verifyManualSnapshot(config.sourcePath, config.byteLength, config.sha256);
  return { schema: 1, packageType: "JPA", sha256: config.sha256, byteLength: config.byteLength, planSha256: cloudPlanSha256(plan),
    managedSourcesSha256: managed.managedSourcesSha256, managedReceiptSha256: managed.managedReceiptSha256,
    documentCount: plan.documentCount, expectedReviewRequired: plan.packageStatus === "review_required", publicationDate: managed.receipt.publicationDate,
    issueNumber: managed.receipt.issueNumber, cumulativeIssue: managed.receipt.cumulativeIssue, amendments: managed.receipt.amendmentCount,
    fullClaims: managed.sources.filter(s => s.status === "complete").length, incompleteClaims: managed.sources.filter(s => s.status !== "complete").length,
    unresolvedCorrections: managed.receipt.corrections.filter(c => c.claimsEffect !== "none").length,
    publicationCounts: { A1: managed.receipt.publishedCount, P1: managed.receipt.translatedCount,
      A5: managed.receipt.publishedAmendments, P5: managed.receipt.translatedAmendments },
    correctionCoverage: { missingOriginalDate: managed.receipt.corrections.filter(c => c.originalPublicationDate === null).length,
      missingOriginalNumber: managed.receipt.corrections.filter(c => c.originalPublicationNumber === null).length },
    zip: parsed.zipSummary ? { entries: parsed.zipSummary.observedEntryCount,
      declaredCompressedBytes: parsed.zipSummary.totalDeclaredCompressedBytes,
      declaredUncompressedBytes: parsed.zipSummary.totalDeclaredUncompressedBytes,
      centralDirectoryBytes: parsed.zipSummary.declaredCentralDirectorySize } : null,
    elapsedMs: Math.ceil(performance.now() - started),
    peakRssKiB: process.resourceUsage().maxRSS };
}
if (require.main === module) {
  const watchdog = setTimeout(() => { process.stdout.write('{"status":"preview_incomplete"}\n'); process.exit(2); }, 115 * 60_000);
  void (async () => {
    try {
      if (process.argv.length !== 2) throw Error(); let bytes = 0; const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 32768) throw Error(); chunks.push(Buffer.from(chunk)); }
      const result = await previewManagedKoho(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch { process.stdout.write('{"status":"preview_incomplete"}\n'); process.exitCode = 2; }
    finally { clearTimeout(watchdog); }
  })();
}
