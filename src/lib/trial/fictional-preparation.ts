import { prepareTrialPackage, TRIAL_PACKAGE_BYTES } from "./package";
import { TrialError } from "./policy";
import { trialHash } from "./ledger";
import { trialFictionalManifestSchema } from "./fictional-manifest";
import { openKohoZip } from "../koho-zip";
import { buildKohoManualImportLimits } from "../koho-import/manual-api";
import { extractManagedClaimSet } from "../koho-import/managed-claim-source";
import { parseKohoXml } from "../koho-xml";
import { managedDigest } from "../patent-watch/managed-claims";
import { managedBaseSourceSchema, verifyManagedBaseOriginal } from "../patent-watch/managed-base-source";
import { validateManagedPeriod, type PublicationPeriod } from "../patent-watch/managed-period";

/** Local-only preparation from unchanged approved bytes. Does not sign, acquire
 * credentials, read files, or send requests. Never derive publication IDs from
 * case ordinals or label this collection as an official distribution table. */
export async function prepareTrialFictionalManifest(input: {
  zip: Buffer; packageSha256: string; period: PublicationPeriod;
  originals: readonly { caseId: number; entryPath: string; bytes: Buffer; sha256: string }[];
}) {
  validateManagedPeriod(input.period);
  const fail = (): never => { throw new TrialError("trial_fixture_unconfirmed"); };
  if (!input.originals.length || input.originals.length > 5 || new Set(input.originals.map(o => o.entryPath)).size !== input.originals.length) fail();
  const pkg = await prepareTrialPackage(input.zip, input.packageSha256), receipt = pkg.managed.receipt;
  if (pkg.plan.documents.length !== input.originals.length || pkg.managed.sources.length !== input.originals.length ||
      receipt.documentCount !== input.originals.length || receipt.amendmentCount || receipt.publishedAmendments ||
      receipt.translatedAmendments || receipt.translatedCorrections || receipt.corrections.length) fail();
  const reader = await openKohoZip({ source: { type: "buffer", bytes: input.zip }, limits: buildKohoManualImportLimits(TRIAL_PACKAGE_BYTES).zip });
  const samples = [];
  try {
    for (const original of input.originals) {
      const docs = pkg.plan.documents.filter(d => d.normalizedEntryPath === original.entryPath);
      const sources = pkg.managed.sources.filter(s => s.normalizedEntryPath === original.entryPath);
      const entries = reader.entries.filter(e => e.normalizedPath === original.entryPath);
      if (docs.length !== 1 || sources.length !== 1 || entries.length !== 1 || trialHash(original.bytes) !== original.sha256) fail();
      const document = docs[0], sidecar = sources[0];
      if (!Buffer.from(await reader.readEntryBytes(entries[0].id)).equals(original.bytes) || sidecar.status !== "complete" ||
          sidecar.contentSha256 !== document.contentSha256 || sidecar.sourceSha256 !== pkg.plan.sourceSha256 || !sidecar.claimsJson ||
          !["A1", "P1"].includes(document.kind)) fail();
      const publicationDate = document.publicationDate.replaceAll("-", "");
      const parsed = parseKohoXml({ packageType: "JPA", entryPath: original.entryPath, xml: original.bytes,
        indexHint: { kindCode: "A", publicationNumber: document.publicationNumber, publicationDate },
        limits: { maxXmlBytes: 1024 ** 2, maxTextBytes: 1024 ** 2, maxDepth: 128, maxElements: 100_000 } });
      if (!("document" in parsed) || !parsed.document || !("identityConfirmed" in parsed) || !parsed.identityConfirmed) throw new TrialError("trial_fixture_unconfirmed");
      const base = extractManagedClaimSet(parsed.document);
      const source = managedBaseSourceSchema.parse({ documentId: original.caseId, packageType: "JPA", entryPath: original.entryPath,
        sha256: original.sha256, publicationDate, applicationNumber: document.applicationNumber });
      verifyManagedBaseOriginal(original.bytes, source, base);
      if (managedDigest(base) !== managedDigest(JSON.parse(sidecar.claimsJson!)) || managedDigest({ schema: 1, source: base }) !== sidecar.claimsDigest) fail();
      const sourceKey = managedDigest({ publicationNumber: document.publicationNumber, content: document.contentSha256,
        numberedClaims: sidecar.claimsDigest, completeness: sidecar.status });
      samples.push({ caseId: original.caseId, base, source, sourceKey });
    }
  } finally { await reader.close(); }
  const manifest = trialFictionalManifestSchema.parse({ schema: 1, kind: "fictional_trial", packageSha256: input.packageSha256,
    period: input.period, issueNumber: receipt.issueNumber, cumulativeIssue: receipt.cumulativeIssue, publicationDate: receipt.publicationDate,
    publishedCount: receipt.publishedCount, translatedCount: receipt.translatedCount,
    records: samples.map(sample => ({ caseId: sample.caseId, originalXmlSha256: sample.source.sha256, sourceKey: sample.sourceKey,
      publicationDate: receipt.publicationDate, kind: sample.base.version })) });
  return { manifest, pkg, samples };
}
