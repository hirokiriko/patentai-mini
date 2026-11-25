import { afterEach, expect, it, vi } from "vitest";
import { readLimitedRelease, assertReleaseSelection, assertReleaseHistory, releaseAllocation, LIMITED_RELEASE_ENV, type LimitedRelease } from "./limited-release";
import { fictionalSaved } from "./fixtures.test-support";
import { savedDigest } from "./comparison";
import { digest } from "./source";
import { sourceAudit } from "./source-audit";

const OLD = "a0000000-0000-4000-8000-000000000001", DEV = "a0000000-0000-4000-8000-000000000002", DAY = "a0000000-0000-4000-8000-000000000003";
function fixture() {
  const saved = fictionalSaved(); saved.inputs.caseId = 104; saved.operationId = DEV; saved.selection.operationId = DEV; saved.snapshotDigest = savedDigest(saved);
  const selection = { ...saved.selection, operationId: OLD }, { operationId: ignored, ...scope } = selection; void ignored;
  const audit = sourceAudit(OLD, selection.inputDigest, [{ id: "b".repeat(64) + ":1", sourceIndex: 0, sourceDigest: "b".repeat(64), claimNo: 1 }], []);
  const failure = { stage: "generation" as const, kind: "protocol_invalid" as const };
  const marker = { version: 1, status: "reserved", operationId: OLD, selection, failure };
  const rows = scope.documents.map(doc => ({ caseId: 104, priorDocId: doc.docId, draftClaimId: String(scope.draftClaimNos[0]), matchedElementsJson: JSON.stringify({ priorArtComparison: marker, priorArtComparisonSourceAudit: audit }) }));
  const now = Date.now();
  const release: LimitedRelease = { schema: "CASE104_LIMITED_RELEASE_V1", caseId: 104, phase: "dev", activeOperationId: DEV, devOperationId: DEV,
    validFromUTC: new Date(now - 1000).toISOString(), validUntilUTC: new Date(now + 60000).toISOString(),
    authority: { sequence: 168, envelopeSHA256: "c".repeat(64), ownerDecisionSHA256: "d".repeat(64) }, scope,
    oldFailure: { operationId: OLD, selectionSHA256: digest(selection), auditDigest: audit.auditDigest, ...failure },
    budget: { maximumSends: 8, maximumJPY: 500, inputYenPer100k: 7, outputYenPer100k: 19 } };
  return { release, rows, saved };
}
afterEach(() => vi.unstubAllEnvs());
it("strict private release configuration binds scope, deadline and server-owned budget", () => {
  const { release } = fixture(); vi.stubEnv(LIMITED_RELEASE_ENV, JSON.stringify(release)); const parsed = readLimitedRelease();
  expect(parsed.value).toEqual(release); expect(releaseAllocation(parsed.value!, parsed.sha256!)).toEqual({ ...release.budget, phase: "dev", releaseSHA256: parsed.sha256, validUntilUTC: release.validUntilUTC });
  assertReleaseSelection(release, 104, { ...release.scope, operationId: DEV });
  for (const selection of [{ ...release.scope, operationId: OLD }, { ...release.scope, operationId: DEV, inputDigest: "e".repeat(64) },
    { ...release.scope, operationId: DEV, draftIdentity: { ...release.scope.draftIdentity, edition: "different" } }]) expect(() => assertReleaseSelection(release, 104, selection)).toThrow();
  expect(() => assertReleaseSelection(release, 105, { ...release.scope, operationId: DEV })).toThrow();
});
it("absent configuration is legacy, while malformed/expired/missing or zero fees stay closed", () => {
  vi.stubEnv(LIMITED_RELEASE_ENV, undefined); expect(readLimitedRelease().configured).toBe(false);
  const { release } = fixture();
  for (const raw of ["", "{}", JSON.stringify({ ...release, validUntilUTC: new Date(Date.now() - 1).toISOString() }),
    JSON.stringify({ ...release, budget: { maximumSends: 8, maximumJPY: 500 } }),
    JSON.stringify({ ...release, budget: { ...release.budget, inputYenPer100k: 0 } }),
    JSON.stringify({ ...release, budget: { ...release.budget, outputYenPer100k: 1.5 } })]) {
    vi.stubEnv(LIMITED_RELEASE_ENV, raw); expect(readLimitedRelease()).toEqual({ configured: true, value: null });
  }
});
it("only exact old terminal rows and matching audit are exempt; unknown, corrupted and other pending remain blocked", () => {
  const { release, rows } = fixture(), original = JSON.stringify(rows); assertReleaseHistory(release, rows, []); expect(JSON.stringify(rows)).toBe(original);
  expect(() => assertReleaseHistory(release, rows.slice(1), [])).toThrow();
  const changed = structuredClone(rows), value = JSON.parse(changed[0].matchedElementsJson); value.priorArtComparison.failure.kind = "timeout"; changed[0].matchedElementsJson = JSON.stringify(value);
  expect(() => assertReleaseHistory(release, changed, [])).toThrow();
  const corrupt = structuredClone(rows), audit = JSON.parse(corrupt[0].matchedElementsJson); audit.priorArtComparisonSourceAudit.auditDigest = "f".repeat(64); corrupt[0].matchedElementsJson = JSON.stringify(audit);
  expect(() => assertReleaseHistory(release, corrupt, [])).toThrow();
  const another = JSON.parse(rows[0].matchedElementsJson); another.priorArtComparison.operationId = DAY;
  expect(() => assertReleaseHistory(release, [...rows, { ...rows[0], matchedElementsJson: JSON.stringify(another) }], [])).toThrow();
});
it("day requires genuine validated dev success and exact saved digest/scope", () => {
  const { release, rows, saved } = fixture(); const day = { ...release, phase: "day" as const, activeOperationId: DAY, devSavedSnapshotDigest: saved.snapshotDigest };
  expect(() => assertReleaseHistory(day, rows, [])).toThrow(); assertReleaseHistory(day, rows, [saved]);
  expect(() => assertReleaseHistory({ ...day, devSavedSnapshotDigest: "a".repeat(64) }, rows, [saved])).toThrow();
});
