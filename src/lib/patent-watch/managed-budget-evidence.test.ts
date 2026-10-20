import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { emptyManagedBudgetUnits, managedCompletionAllowanceSchema } from "./managed-service-budget";
import { managedBudgetEvidencePins, managedSettlementReviewSchema, managedSettlementProof, verifyManagedSettlementReview,
  managedReleaseStepSchema, managedReleaseBudgetRequest, managedIssue150IntegrationSchema,
  verifyManagedAdministrationReview, verifyManagedAdministrationHistory,
  type ManagedSettlementReview } from "./managed-budget-evidence";

const hash = (n: number) => n.toString(16).padStart(64, "0"), now = new Date("2026-09-24T00:00:00Z");
function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), der = publicKey.export({ format: "der", type: "spki" });
  const pins = { publicKeySpkiBase64: der.toString("base64"), publicKeySha256: createHash("sha256").update(der).digest("hex"),
    ownerBindingHash: hash(1), targetBindingHash: hash(2) };
  const review: ManagedSettlementReview = { schema: 1, purpose: "MANAGED_WATCH_SETTLEMENT_REVIEW_V1",
    ownerBindingHash: pins.ownerBindingHash, targetBindingHash: pins.targetBindingHash,
    operationId: "00000000-0000-4000-8000-000000000001", requestDigest: hash(3), pricingDigest: hash(4),
    sequence: 1, previousProofDigest: null, issuedAt: "2026-09-23T00:00:00Z", validUntil: "2026-09-25T00:00:00Z",
    sources: [{ digest: hash(5), bytes: 80 }], finalizedUnits: { jobs: 1 },
    unitEvidence: [{ unit: "jobs", sourceDigest: hash(5) }], cost: null };
  const signed = (value = review) => { const canonical = managedSettlementReviewSchema.parse(value);
    return { review: canonical, signature: sign(null, Buffer.from(managedDigest(canonical), "hex"), privateKey).toString("base64") }; };
  const signedReview = <T>(review: T) => ({ review,
    signature: sign(null, Buffer.from(managedDigest(review), "hex"), privateKey).toString("base64") });
  return { pins, review, signed, signedReview };
}
function history139Fixture() {
  const f = fixture(), review = { schema: 1, purpose: "MANAGED_WATCH_ADMINISTRATION_REVIEW_V1",
    targetBindingHash: f.pins.targetBindingHash, ownerBindingHash: f.pins.ownerBindingHash,
    sequence: 2, previousReviewDigest: hash(6), expectedStateDigest: hash(7),
    issuedAt: "2026-09-24T00:00:00Z", validUntil: "2026-09-24T00:10:00Z",
    sources: [{ digest: hash(8), bytes: 80 }, { digest: hash(9), bytes: 80 }],
    action: { kind: "release-start", step: { issue: 139, repository: "hirokiriko/patentai-mini",
      operationId: "00000000-0000-4000-8000-000000000139", kind: "forward", trigger: "squash-merge",
      prNumber: 139, targetRef: "refs/heads/main", remoteBeforeSha: "b".repeat(40), headSha: "a".repeat(40),
      baseSha: "b".repeat(40), treeSha: "c".repeat(40), ciWorkflowSha256: hash(10), deployWorkflowSha256: hash(11),
      preflightDigest: hash(8), pricingDigest: hash(9), reservationYen: 115 } } };
  return { ...f, review };
}
it("authenticates signed Issue139 history without adding active release authority", () => {
  const f = history139Fixture(), envelope = f.signedReview(f.review), digest = managedDigest(envelope);
  for (const at of [now, new Date("2026-10-19T00:00:00Z")])
    expect(JSON.stringify(verifyManagedAdministrationHistory(envelope, digest, f.pins, at))).toBe(JSON.stringify(envelope));
  for (const requireFresh of [true, false])
    expect(() => verifyManagedAdministrationReview(envelope, digest, f.pins, now, requireFresh)).toThrow();
  expect(() => managedReleaseStepSchema.parse(f.review.action.step)).toThrow();
  expect(() => managedReleaseBudgetRequest(f.review.action.step, f.pins.targetBindingHash, f.pins.ownerBindingHash)).toThrow();
});
it.each(["content", "signature", "key", "owner", "target", "digest", "future"])(
  "rejects invalid historical Issue139 authentication: %s", reason => {
    const f = history139Fixture(), envelope = f.signedReview(f.review);
    if (reason === "content") envelope.review.action.step.headSha = "e".repeat(40);
    if (reason === "signature") envelope.signature = history139Fixture().signedReview(f.review).signature;
    if (reason === "key") Object.assign(f.pins, history139Fixture().pins);
    if (reason === "owner") f.pins.ownerBindingHash = hash(90);
    if (reason === "target") f.pins.targetBindingHash = hash(90);
    expect(() => verifyManagedAdministrationHistory(envelope, reason === "digest" ? hash(90) : managedDigest(envelope), f.pins,
      reason === "future" ? new Date("2026-09-23T23:59:59Z") : now)).toThrow();
  });
it.each(["completion140", "integration150-v1", "integration150-v2", "integration150-v3", "integration150-v4"])(
  "rejects foreign authority on signed Issue139 history: %s", reason => {
    const f = history139Fixture();
    const patch = reason === "completion140" ? { completionAllowance: managedCompletionAllowanceSchema.parse({
      scope: "ISSUE140_COMPLETION_V2", issue: 140, month: "2026-10", ownerApprovalDigest: hash(12), profileDigest: hash(13),
      monthlyCapYen: 30000, cumulativeUnits: emptyManagedBudgetUnits(), validUntil: "2026-10-20T14:59:00Z" }) } : {
      issue150Integration: managedIssue150IntegrationSchema.parse({
        scope: reason === "integration150-v1" ? "ISSUE150_INTEGRATION_V1" : reason === "integration150-v2" ? "ISSUE150_INTEGRATION_V2" :
          reason === "integration150-v3" ? "ISSUE150_INTEGRATION_V3" : "ISSUE150_INTEGRATION_V4",
        ownerApprovalDigest: hash(12), profileDigest: hash(13), forwardOperationId: null,
        approvedAt: reason === "integration150-v1" ? "2026-10-17T06:41:40Z" : "2026-10-19T00:00:00Z",
        validUntil: reason === "integration150-v1" ? "2026-10-18T06:41:40Z" : "2026-10-20T14:59:00Z" }) };
    const envelope = f.signedReview({ ...f.review, action: { ...f.review.action, step: { ...f.review.action.step, ...patch } } });
    expect(() => verifyManagedAdministrationHistory(envelope, managedDigest(envelope), f.pins, now)).toThrow();
  });
it.each([{ targetRef: "refs/tags/issue-139" }, { targetRef: "refs/heads/codex//issue-139" },
  { targetRef: "refs/heads/codex/issue-139/" }, { remoteBeforeSha: null }, { remoteBeforeSha: "d".repeat(40) },
  { headSha: "a".repeat(39) }, { baseSha: "b".repeat(64) }, { treeSha: "G".repeat(40) },
  { trigger: "workflow-dispatch", prNumber: null }])("rejects malformed signed Issue139 refs/SHA %#", patch => {
  const f = history139Fixture();
  const envelope = f.signedReview({ ...f.review, action: { ...f.review.action, step: { ...f.review.action.step, ...patch } } });
  expect(() => verifyManagedAdministrationHistory(envelope, managedDigest(envelope), f.pins, now)).toThrow();
});
it("verifies the independently pinned Ed25519 key and keeps partial evidence monetary-unknown", () => {
  const f = fixture(), envelope = f.signed(), digest = managedDigest(envelope);
  expect(verifyManagedSettlementReview(envelope, digest, f.pins, now)).toEqual(envelope);
  expect(managedSettlementProof(f.review, digest)).toEqual({ operationId: f.review.operationId,
    requestDigest: f.review.requestDigest, sequence: 1, evidenceDigest: digest, knownUnits: { jobs: 1 } });
  expect(managedBudgetEvidencePins({ MANAGED_BUDGET_REVIEW_PUBLIC_KEY: f.pins.publicKeySpkiBase64,
    MANAGED_BUDGET_REVIEW_KEY_SHA256: f.pins.publicKeySha256, MANAGED_BUDGET_OWNER_SHA256: f.pins.ownerBindingHash,
    MANAGED_BUDGET_TARGET_SHA256: f.pins.targetBindingHash })).toEqual(f.pins);
});
it.each(["signature", "key", "owner", "target", "digest", "future", "expiry", "duration", "unit-source", "cost-source", "cost-operation", "duplicate-source", "duplicate-unit", "missing-unit", "partial-final", "lower-final", "empty"])(
  "rejects invalid %s without exposing submitted content", reason => {
    const f = fixture(), r = f.review;
    if (reason === "future") r.issuedAt = "2026-09-24T01:00:00Z";
    if (reason === "expiry") r.validUntil = "2026-09-24T00:00:00Z";
    if (reason === "duration") r.validUntil = "2026-10-23T00:00:00Z";
    if (reason === "unit-source") r.unitEvidence[0].sourceDigest = hash(90);
    if (reason === "cost-source" || reason === "cost-operation" || reason === "partial-final" || reason === "lower-final") {
      r.cost = { operationId: r.operationId, sourceDigest: hash(5), observedYen: 20, finalYen: null };
      if (reason === "cost-source") r.cost.sourceDigest = hash(90);
      if (reason === "cost-operation") r.cost.operationId = "00000000-0000-4000-8000-000000000099";
      if (reason === "partial-final") r.cost.finalYen = 20;
      if (reason === "lower-final") { r.finalizedUnits = emptyManagedBudgetUnits();
        r.unitEvidence = Object.keys(r.finalizedUnits).map(unit => ({ unit: unit as keyof typeof r.finalizedUnits, sourceDigest: hash(5) })); r.cost.finalYen = 19; }
    }
    if (reason === "duplicate-source") r.sources.push(r.sources[0]);
    if (reason === "duplicate-unit") r.unitEvidence.push(r.unitEvidence[0]);
    if (reason === "missing-unit") r.finalizedUnits.minutes = 2;
    if (reason === "empty") { r.finalizedUnits = {}; r.unitEvidence = []; }
    const envelope = f.signed();
    if (reason === "signature") envelope.signature = fixture().signed(r).signature;
    if (reason === "key") f.pins.publicKeySha256 = hash(90);
    if (reason === "owner") f.pins.ownerBindingHash = hash(90);
    if (reason === "target") f.pins.targetBindingHash = hash(90);
    expect(() => verifyManagedSettlementReview(envelope, reason === "digest" ? hash(90) : managedDigest(envelope), f.pins, now))
      .toThrow("managed_budget_stopped");
  });
it("permits expired evidence for read-only reconciliation but still verifies its signature and issue time", () => {
  const f = fixture(), envelope = f.signed();
  expect(verifyManagedSettlementReview(envelope, managedDigest(envelope), f.pins, new Date("2026-10-01T00:00:00Z"), false)).toEqual(envelope);
  expect(() => verifyManagedSettlementReview(envelope, managedDigest(envelope), f.pins, new Date("2026-09-22T00:00:00Z"), false)).toThrow();
});
