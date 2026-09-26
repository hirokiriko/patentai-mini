import { z } from "zod";
import { parseDistributionTable, DISTRIBUTION_LIMITS } from "../koho-distribution-table";
import { managedHash, ManagedWatchError } from "./managed-types";
import { managedDate, type PublicationPeriod } from "./managed-period";

export const MANAGED_DISTRIBUTION_URL = "https://www.gazette.jpo.go.jp/scciidl040/onclickfilemeilink?file=JPA.csv";
export const managedCoverageSchema = z.object({ distributionTableSha256: managedHash }).strict();
export type ManagedCoverage = z.infer<typeof managedCoverageSchema>;
export const validateManagedCoverage = (value: unknown) => managedCoverageSchema.parse(value);

/** Used only by the authenticated operator acquisition command; never accepts a URL. */
export async function acquireManagedDistribution() {
  const response = await fetch(MANAGED_DISTRIBUTION_URL, { redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new ManagedWatchError("unavailable");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > DISTRIBUTION_LIMITS.bytes) throw new ManagedWatchError("limit");
      chunks.push(value);
    }
  } finally { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks), parsed = parseDistributionTable({ bytes, packageType: "JPA" });
  if (!parsed.ok || parsed.warnings.length || !parsed.sourceRowCount) throw new ManagedWatchError("incomplete");
  return { sha256: parsed.sourceSha256, sourceUrl: MANAGED_DISTRIBUTION_URL, csvText: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), acquiredAt: new Date().toISOString() };
}

export function managedDistributionRows(snapshot: { sha256: string; sourceUrl: string; csvText: string; acquiredAt: string }, period: PublicationPeriod) {
  const parsed = parseDistributionTable({ bytes: Buffer.from(snapshot.csvText), packageType: "JPA", ...period });
  const acquired = new Date(snapshot.acquiredAt);
  const acquiredOn = new Date(acquired.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 10);
  managedDate(acquiredOn);
  if (snapshot.sourceUrl !== MANAGED_DISTRIBUTION_URL || !parsed.ok || parsed.sourceSha256 !== snapshot.sha256 ||
    parsed.warnings.length || !parsed.sourceRowCount || acquiredOn < period.to || acquired.getTime() > Date.now() + 60_000) throw new ManagedWatchError("incomplete");
  return parsed.rows.map(row => {
    if (row.packageType !== "JPA" || row.notes.trim()) throw new ManagedWatchError("incomplete");
    return { publicationDate: row.publicationDate, issueNumber: `${row.publicationYear}-${row.annualIssue}`, cumulativeIssue: row.cumulativeIssue,
      publishedCount: row.dailyCounts.published, translatedCount: row.dailyCounts.translated, available: row.downloadAvailability === "available" };
  });
}
