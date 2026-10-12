import { readTrialPolicy, requireTrialActive, TrialError, type TrialPolicy } from "./policy";
import { TRIAL_FICTIONAL_SOURCE, trialFictionalBytes, trialFictionalDigest, type TrialFictionalManifest } from "./fictional-manifest";
import type { PublicationPeriod } from "../patent-watch/managed-period";

type Snapshot = { sha256: string; sourceUrl: string; csvText: string; acquiredAt: string };
/** This boundary has no fallback to official acquisition. Only a verified,
 * active policy can authorize a particular case and fictional data set. */
function manifestForPolicy(policy: TrialPolicy, caseId: number | undefined, period?: PublicationPeriod) {
  const value = policy.fictionalDistribution, sample = policy.samples.find(row => row.caseId === caseId);
  if (!value || !sample || !value.records.some(row => row.caseId === caseId) ||
      (period && (period.from !== sample.from || period.to !== sample.through))) throw new TrialError("trial_fixture_unconfirmed");
  return value;
}
export function trialFictionalManifest(caseId: number | undefined, period?: PublicationPeriod) {
  const policy = readTrialPolicy(); requireTrialActive(policy);
  return manifestForPolicy(policy, caseId, period);
}
/** Existing-result reconciliation has its own scoped operator ticket window.
 * Public callers still pass their route's active-period guard. This grants no
 * new distribution, artifact write, AI request, or unverified-policy access. */
export function trialFictionalManifestForStoredRead(caseId: number, period: PublicationPeriod) {
  return manifestForPolicy(readTrialPolicy(), caseId, period);
}
export function acquireTrialFictionalDistribution(caseId: number | undefined): Snapshot {
  const manifest = trialFictionalManifest(caseId);
  return { sha256: trialFictionalDigest(manifest), sourceUrl: TRIAL_FICTIONAL_SOURCE,
    csvText: trialFictionalBytes(manifest).toString("utf8"), acquiredAt: new Date().toISOString() };
}
/** The existing private snapshot text column stores explicitly typed JSON for
 * this source. It is never passed to the official CSV parser. */
export function trialFictionalDistributionRows(snapshot: Snapshot, manifest: TrialFictionalManifest) {
  const observed = Date.parse(snapshot.acquiredAt), now = Date.now();
  if (snapshot.sourceUrl !== TRIAL_FICTIONAL_SOURCE || snapshot.sha256 !== trialFictionalDigest(manifest) ||
      snapshot.csvText !== trialFictionalBytes(manifest).toString("utf8") || !Number.isFinite(observed) ||
      observed > now + 60_000 || new Date(observed + 9 * 3_600_000).toISOString().slice(0, 10) < manifest.period.to)
    throw new TrialError("trial_fixture_unconfirmed");
  return [{ publicationDate: manifest.publicationDate, issueNumber: manifest.issueNumber,
    cumulativeIssue: manifest.cumulativeIssue, publishedCount: manifest.publishedCount,
    translatedCount: manifest.translatedCount, available: true }];
}
