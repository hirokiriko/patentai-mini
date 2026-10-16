import { afterEach, describe, expect, it, vi } from "vitest";
import { trialFixture, signedTrialEnvironment } from "./policy.test-support";
import { readTrialPolicy, trialPolicyBytes, trialPolicySchema } from "./policy";
import { trialFictionalBytes, trialFictionalDigest, trialFictionalManifestSchema, type TrialFictionalManifest } from "./fictional-manifest";
import { acquireTrialFictionalDistribution, trialFictionalDistributionRows } from "./fictional-distribution";
import { managedDistributionRows } from "../patent-watch/managed-distribution";

const manifest = (): TrialFictionalManifest => ({ schema: 1, kind: "fictional_trial", packageSha256: "b".repeat(64),
  period: { from: "2026-09-01", to: "2026-09-25" }, issueNumber: "2026-148", cumulativeIssue: "01115",
  publicationDate: "2026-09-01", publishedCount: 1, translatedCount: 0,
  records: [{ caseId: 1, originalXmlSha256: "c".repeat(64), sourceKey: "d".repeat(64), publicationDate: "2026-09-01", kind: "A1" }] });
const policy = () => ({ ...structuredClone(trialFixture), samples: [{ caseId: 1, from: "2026-09-01", through: "2026-09-25" }], fictionalDistribution: manifest() });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe("signed fictional distribution boundary", () => {
  it("acquires only the signed typed collection and cannot enter the official parser", () => {
    const p = policy(); for (const [k, v] of Object.entries(signedTrialEnvironment(p))) vi.stubEnv(k, v);
    vi.useFakeTimers(); vi.setSystemTime("2026-10-17T00:01:00Z");
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network forbidden"));
    const snapshot = acquireTrialFictionalDistribution(1);
    expect(trialFictionalDistributionRows(snapshot, p.fictionalDistribution)).toEqual([{ publicationDate: "2026-09-01", issueNumber: "2026-148", cumulativeIssue: "01115", publishedCount: 1, translatedCount: 0, available: true }]);
    expect(() => managedDistributionRows(snapshot, p.fictionalDistribution.period)).toThrow();
    expect(() => acquireTrialFictionalDistribution(2)).toThrow("trial_fixture_unconfirmed");
    for (const mutation of [{ sha256: "e".repeat(64) }, { sourceUrl: "https://fictional.invalid/table.csv" }, { csvText: snapshot.csvText + " " }, { acquiredAt: "2026-09-02T00:00:00Z" }, { acquiredAt: "2026-10-18T00:00:00Z" }])
      expect(() => trialFictionalDistributionRows({ ...snapshot, ...mutation }, p.fictionalDistribution)).toThrow("trial_fixture_unconfirmed");
    vi.setSystemTime(p.endsAt); expect(() => acquireTrialFictionalDistribution(1)).toThrow("trial_outside_period");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("rejects changed signed bytes, absent descriptors, and mismatched sample sets", () => {
    const p = policy(), env = signedTrialEnvironment(p); p.fictionalDistribution.packageSha256 = "e".repeat(64);
    expect(() => readTrialPolicy({ ...env, TRIAL_POLICY_JSON: JSON.stringify(p) })).toThrow();
    for (const [k, v] of Object.entries(signedTrialEnvironment())) vi.stubEnv(k, v);
    vi.useFakeTimers(); vi.setSystemTime("2026-10-17T00:01:00Z");
    expect(() => acquireTrialFictionalDistribution(1)).toThrow("trial_fixture_unconfirmed");
    for (const samples of [[], [{ caseId: 2, from: "2026-09-01", through: "2026-09-25" }], [{ caseId: 1, from: "2026-09-01", through: "2026-09-30" }]])
      expect(trialPolicySchema.safeParse({ ...policy(), samples }).success).toBe(false);
  });
  it("rejects impossible metadata and preserves legacy signed policy bytes", () => {
    const m = manifest();
    for (const mutation of [{ period: { ...m.period, to: "2026-09-30" } }, { packageSha256: "bad" }, { issueNumber: "unverified" }, { cumulativeIssue: "1" }, { publicationDate: "2026-09-02" }, { publishedCount: 2 }, { translatedCount: 1 }, { records: [] }, { records: [m.records[0], m.records[0]] }, { unexpected: true }])
      expect(trialFictionalManifestSchema.safeParse({ ...m, ...mutation }).success).toBe(false);
    expect(trialFictionalBytes(m).toString()).not.toContain("https:");
    expect(trialFictionalDigest(m)).toMatch(/^[a-f0-9]{64}$/);
    expect(trialPolicyBytes(trialFixture).toString()).not.toContain("fictionalDistribution");
  });
});
