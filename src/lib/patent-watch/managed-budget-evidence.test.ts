import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { emptyManagedBudgetUnits, managedCompletionAllowanceSchema } from "./managed-service-budget";
import { managedBudgetEvidencePins, managedSettlementReviewSchema, managedSettlementProof, verifyManagedSettlementReview,
  managedReleaseStepSchema, managedReleaseBudgetRequest, managedIssue150IntegrationSchema, managedIssue150PreflightSchema, managedAdministrationReviewSchema,
  verifyManagedAdministrationReview, verifyManagedAdministrationHistory,
  type ManagedSettlementReview, type ManagedBudgetEvidencePins } from "./managed-budget-evidence";

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
function history139Pr146Fixture() {
  const f = history139Fixture(), review = { ...f.review,
    issuedAt: "2026-10-06T13:29:25Z", validUntil: "2026-10-06T13:44:25Z",
    sources: [...f.review.sources, { digest: hash(12), bytes: 80 },
      { digest: "88953f0020b0a1187474de4a1f4dd65d389230b8fc6a69a546b666c19acaf0cc", bytes: 80 }],
    action: { ...f.review.action, step: { ...f.review.action.step, prNumber: 146, reservationYen: 255,
      headSha: "5ed2d92474aa417c30fa5d7b83946795c7bf3120", baseSha: "62491ef671ae47ffe190800b254bcb62a4404ed3",
      remoteBeforeSha: "62491ef671ae47ffe190800b254bcb62a4404ed3",
      completionAllowance: managedCompletionAllowanceSchema.parse({ scope: "ISSUE140_COMPLETION_V2", issue: 140,
        month: "2026-10", ownerApprovalDigest: hash(12), profileDigest: hash(13), monthlyCapYen: 45000,
        cumulativeUnits: { ...emptyManagedBudgetUnits(), forward: 15 }, validUntil: "2026-10-31T15:00:00Z" }) } } };
  const canonical = managedAdministrationReviewSchema.parse({ ...review,
    action: { ...review.action, step: { ...review.action.step, issue: 140 } } });
  if (canonical.action.kind !== "release-start") throw new Error("fixture");
  return { ...f, review: { ...canonical, action: { kind: "release-start" as const, step: {
    ...canonical.action.step, issue: 139, completionAllowance: review.action.step.completionAllowance } } } };
}
it("reads the historical PR146 allowance without allowing apply or reconciliation", () => {
  const f = history139Pr146Fixture(), envelope = f.signedReview(f.review), digest = managedDigest(envelope);
  const at = new Date("2026-10-21T00:00:00Z");
  expect(verifyManagedAdministrationHistory(envelope, digest, f.pins, at)).toEqual(envelope);
  for (const fresh of [true, false]) expect(() => verifyManagedAdministrationReview(envelope, digest, f.pins, at, fresh)).toThrow();
  expect(() => managedReleaseStepSchema.parse(f.review.action.step)).toThrow();
  expect(() => managedReleaseBudgetRequest(f.review.action.step, f.pins.targetBindingHash, f.pins.ownerBindingHash)).toThrow();
});
it.each(["pr", "head", "base", "remote", "reservation", "cap", "forward", "kind", "trigger", "ref", "expectedState",
  "owner-source", "pricing-source", "preflight-source", "approval-source", "month", "expiry", "duration", "integration150"])(
  "rejects a re-signed incompatible PR146 history: %s", reason => {
    const f = history139Pr146Fixture(), r = f.review, s = r.action.step;
    if (reason === "pr") s.prNumber = 147;
    if (reason === "head") s.headSha = "d".repeat(40);
    if (reason === "base") s.baseSha = "d".repeat(40);
    if (reason === "remote") s.remoteBeforeSha = "d".repeat(40);
    if (reason === "reservation") s.reservationYen = 256;
    if (reason === "cap") s.completionAllowance.monthlyCapYen = 45001;
    if (reason === "forward") s.completionAllowance.cumulativeUnits.forward = 16;
    if (reason === "kind") s.kind = "rollback";
    if (reason === "trigger") s.trigger = "workflow-dispatch";
    if (reason === "ref") s.targetRef = "refs/heads/codex/other";
    if (reason === "expectedState") Object.assign(r, { expectedStateDigest: null });
    const missing = reason === "owner-source" ? hash(12) : reason === "pricing-source" ? hash(9) :
      reason === "preflight-source" ? hash(8) : reason === "approval-source" ?
        "88953f0020b0a1187474de4a1f4dd65d389230b8fc6a69a546b666c19acaf0cc" : null;
    if (missing) r.sources = r.sources.filter(x => x.digest !== missing);
    if (reason === "month") { r.issuedAt = "2026-09-30T14:40:00Z"; r.validUntil = "2026-09-30T14:50:00Z"; }
    if (reason === "expiry") s.completionAllowance.validUntil = "2026-10-06T13:35:00Z";
    if (reason === "duration") r.validUntil = "2026-10-06T13:44:26Z";
    if (reason === "integration150") Object.assign(s, { issue150Integration: {} });
    const envelope = f.signedReview(r);
    expect(() => verifyManagedAdministrationHistory(envelope, managedDigest(envelope), f.pins, new Date("2026-10-21T00:00:00Z"))).toThrow();
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
it.each(["completion140", "integration150-v1", "integration150-v2", "integration150-v3", "integration150-v4", "integration150-v5", "integration150-v6"])(
  "rejects foreign authority on signed Issue139 history: %s", reason => {
    const f = history139Fixture();
    const patch = reason === "completion140" ? { completionAllowance: managedCompletionAllowanceSchema.parse({
      scope: "ISSUE140_COMPLETION_V2", issue: 140, month: "2026-10", ownerApprovalDigest: hash(12), profileDigest: hash(13),
      monthlyCapYen: 30000, cumulativeUnits: emptyManagedBudgetUnits(), validUntil: "2026-10-20T14:59:00Z" }) } : {
      issue150Integration: managedIssue150IntegrationSchema.parse({
        scope: reason === "integration150-v1" ? "ISSUE150_INTEGRATION_V1" : reason === "integration150-v2" ? "ISSUE150_INTEGRATION_V2" :
          reason === "integration150-v3" ? "ISSUE150_INTEGRATION_V3" : reason === "integration150-v4" ? "ISSUE150_INTEGRATION_V4" : reason === "integration150-v5" ? "ISSUE150_INTEGRATION_V5" : "ISSUE150_INTEGRATION_V6",
        ownerApprovalDigest: hash(12), profileDigest: hash(13), forwardOperationId: null,
        approvedAt: reason === "integration150-v1" ? "2026-10-17T06:41:40Z" : "2026-10-19T00:00:00Z",
        validUntil: reason === "integration150-v1" ? "2026-10-18T06:41:40Z" : "2026-10-20T14:59:00Z" }) };
    const envelope = f.signedReview({ ...f.review, action: { ...f.review.action, step: { ...f.review.action.step, ...patch } } });
    expect(() => verifyManagedAdministrationHistory(envelope, managedDigest(envelope), f.pins, now)).toThrow();
  });
it.each([[1,3000,1600],[2,4843,1400],[3,5421,1400],[4,5437,1400],[5,5509,1400],[6,5588,1400],[7,5685,1400]] as const)(
  "keeps the exact historical V%i AI and rollback ceilings", (version, aiExposureYen, rollbackReserveYen) => {
    const facts = { scope: `ISSUE150_INTEGRATION_PREFLIGHT_V${version}`, ownerApprovalDigest: hash(12),
      technicalGoHeadSha: "a".repeat(40), technicalGoTreeSha: "b".repeat(40), baseTreeSha: "c".repeat(40),
      aiExposureYen, rollbackReserveYen, forwardResultDigest: null,
      ...(version >= 3 ? { productionNonAiReserveYen: 150 } : {}) };
    expect(managedIssue150PreflightSchema.parse(facts)).toEqual(facts);
    expect(() => managedIssue150PreflightSchema.parse({ ...facts, aiExposureYen: aiExposureYen + 1 })).toThrow();
    expect(() => managedIssue150PreflightSchema.parse({ ...facts, rollbackReserveYen: rollbackReserveYen + 1 })).toThrow();
  });
function issue150ReviewFixture(version: 5 | 6 | 7) {
  const f = history139Fixture();
  const review = { ...f.review, issuedAt: version === 7 ? "2026-10-21T00:00:00Z" : "2026-10-20T00:00:00Z",
    validUntil: version === 7 ? "2026-10-21T00:10:00Z" : "2026-10-20T00:10:00Z",
    sources: [...f.review.sources, { digest: hash(12), bytes: 80 }],
    action: { ...f.review.action, step: { ...f.review.action.step, issue: 150,
      issue150Integration: { scope: `ISSUE150_INTEGRATION_V${version}`, ownerApprovalDigest: hash(12), profileDigest: hash(13),
        approvedAt: version === 7 ? "2026-10-21T00:00:00Z" : "2026-10-19T00:00:00Z",
        validUntil: version === 7 ? "2026-10-23T14:59:00Z" : "2026-10-20T14:59:00Z", forwardOperationId: null } } } };
  Object.assign(review, managedAdministrationReviewSchema.parse(review));
  return { ...f, review };
}
function replacementFixture() {
  const old = issue150ReviewFixture(6), oldEnvelope = old.signedReview(old.review), fresh = issue150ReviewFixture(7);
  fresh.review.sequence = 3; fresh.review.previousReviewDigest = managedDigest(oldEnvelope);
  const envelope = fresh.signedReview(fresh.review), digest = managedDigest(envelope);
  const pins: ManagedBudgetEvidencePins = { ...old.pins, issue150Replacement: {
    scope: "ISSUE150_KEY_REPLACEMENT_V1", ownerApprovalDigest: hash(12), validUntil: "2026-10-23T14:59:00Z",
    publicKeySpkiBase64: fresh.pins.publicKeySpkiBase64, publicKeySha256: fresh.pins.publicKeySha256,
    historicalAdministration: [{sequence:1,digest:hash(1)}, {sequence:2,digest:managedDigest(oldEnvelope)}],
    administrationReviewDigests: [managedDigest(envelope.review)], settlementReviewDigests: [],
    operationIds: [fresh.review.action.step.operationId],
  } };
  return { old, fresh, oldEnvelope, envelope, digest, pins, at: new Date("2026-10-21T00:05:00Z") };
}
it("binds PR146 history to the exact old-key prefix during replacement", () => {
  const f = replacementFixture(), old = history139Pr146Fixture(), envelope = old.signedReview(old.review), digest = managedDigest(envelope);
  const pins: ManagedBudgetEvidencePins = { ...old.pins, issue150Replacement: { ...f.pins.issue150Replacement!,
    historicalAdministration: [{ sequence: 1, digest: hash(1) }, { sequence: 2, digest }] } };
  expect(verifyManagedAdministrationHistory(envelope, digest, pins, f.at)).toEqual(envelope);
  pins.issue150Replacement!.historicalAdministration[1].digest = hash(91);
  expect(() => verifyManagedAdministrationHistory(envelope, digest, pins, f.at)).toThrow();
  pins.issue150Replacement!.historicalAdministration.pop();
  expect(() => verifyManagedAdministrationHistory(envelope, digest, pins, f.at)).toThrow();
});
it("separates exact old history from new Issue150 authority, without changing the default pin loader", () => {
  const f = replacementFixture(), original = JSON.stringify(f.oldEnvelope);
  expect(verifyManagedAdministrationHistory(f.oldEnvelope, managedDigest(f.oldEnvelope), f.pins, f.at)).toEqual(f.oldEnvelope);
  expect(verifyManagedAdministrationReview(f.envelope, f.digest, f.pins, f.at)).toEqual(f.envelope);
  expect(verifyManagedAdministrationHistory(f.envelope, f.digest, f.pins, new Date("2026-10-24T00:00:00Z"))).toEqual(f.envelope);
  for (const fresh of [true, false]) {
    expect(() => verifyManagedAdministrationReview(f.oldEnvelope, managedDigest(f.oldEnvelope), f.pins, f.at, fresh)).toThrow();
  }
  expect(() => verifyManagedAdministrationReview(f.envelope, f.digest, f.pins, new Date("2026-10-24T00:00:00Z"))).toThrow();
  expect(verifyManagedAdministrationReview(f.envelope, f.digest, f.pins, new Date("2026-10-24T00:00:00Z"), false)).toEqual(f.envelope);
  expect(JSON.stringify(f.oldEnvelope)).toBe(original);
  expect(managedBudgetEvidencePins({
    MANAGED_BUDGET_REVIEW_PUBLIC_KEY:f.old.pins.publicKeySpkiBase64,MANAGED_BUDGET_REVIEW_KEY_SHA256:f.old.pins.publicKeySha256,
    MANAGED_BUDGET_OWNER_SHA256:f.old.pins.ownerBindingHash,MANAGED_BUDGET_TARGET_SHA256:f.old.pins.targetBindingHash,
    ISSUE150_KEY_REPLACEMENT:JSON.stringify(f.pins.issue150Replacement),
  })).not.toHaveProperty("issue150Replacement");
});
it.each(["unreviewed","old-key","new-pin","owner","operation","old-history-digest","old-history-sequence","other-issue"] as const)(
  "rejects replacement boundary violation %s", reason => {
    const f = replacementFixture(), p = f.pins.issue150Replacement!;
    let envelope = f.envelope;
    if(reason==="unreviewed")p.administrationReviewDigests=[];
    if(reason==="old-key")envelope=f.old.signedReview(f.envelope.review);
    if(reason==="new-pin")p.publicKeySha256=hash(88);
    if(reason==="owner")p.ownerApprovalDigest=hash(89);
    if(reason==="operation")p.operationIds=[];
    if(reason==="old-history-digest")p.historicalAdministration[1].digest=hash(90);
    if(reason==="old-history-sequence")p.historicalAdministration[1].sequence=3;
    if(reason==="other-issue"){
      const old139=history139Fixture().review;
      const review={...f.envelope.review,action:old139.action};
      envelope=f.fresh.signedReview(review) as typeof envelope;p.administrationReviewDigests=[managedDigest(review)];
    }
    if(reason.startsWith("old-history"))
      expect(()=>verifyManagedAdministrationHistory(f.oldEnvelope,managedDigest(f.oldEnvelope),f.pins,f.at)).toThrow();
    else expect(()=>verifyManagedAdministrationReview(envelope,managedDigest(envelope),f.pins,f.at,false)).toThrow();
  });
it("accepts only the reviewed new-key settlement for the bounded Issue150 operation", () => {
  const f=replacementFixture(), r={...f.fresh.review};
  const s=fixture(), review=managedSettlementReviewSchema.parse({...s.review,operationId:r.action.step.operationId,issuedAt:r.issuedAt,validUntil:r.validUntil,
    sources:[...s.review.sources,{digest:hash(12),bytes:80}]});
  const envelope=f.fresh.signedReview(review), p=f.pins.issue150Replacement!;
  p.settlementReviewDigests=[managedDigest(review)];
  expect(verifyManagedSettlementReview(envelope,managedDigest(envelope),f.pins,f.at)).toEqual(envelope);
  const old=f.old.signedReview(review);
  expect(()=>verifyManagedSettlementReview(old,managedDigest(old),f.pins,f.at,false)).toThrow();
  p.operationIds=[];
  expect(()=>verifyManagedSettlementReview(envelope,managedDigest(envelope),f.pins,f.at,false)).toThrow();
});
it.each([5,6] as const)("authenticates immutable V%s history while an expired review cannot authorize a new start", version => {
  const f = issue150ReviewFixture(version), envelope = f.signedReview(f.review), digest = managedDigest(envelope);
  const bytes = JSON.stringify(envelope), at = new Date("2026-10-20T00:05:00Z");
  expect(verifyManagedAdministrationReview(envelope, digest, f.pins, at)).toEqual(envelope);
  expect(verifyManagedAdministrationHistory(envelope, digest, f.pins, new Date("2026-10-21T00:00:00Z"))).toEqual(envelope);
  expect(JSON.stringify(envelope)).toBe(bytes);
  expect(() => verifyManagedAdministrationReview(envelope, digest, f.pins, new Date("2026-10-21T00:00:00Z"))).toThrow();
});
it.each(([5,6] as const).flatMap(version => ["signature", "key", "owner", "target", "digest", "head", "approval-before", "approval-expiry", "extended-expiry"].map(reason => ({version,reason}))))(
  "rejects V$version $reason without changing signature pins or the approval window", ({version,reason}) => {
    const f = issue150ReviewFixture(version), at = new Date("2026-10-20T00:05:00Z");
    const approval = f.review.action.step.issue150Integration;
    if (reason === "head") f.review.action.step.headSha = "a".repeat(39);
    if (reason === "approval-before") approval.approvedAt = "2026-10-18T23:59:59Z";
    if (reason === "approval-expiry") approval.approvedAt = approval.validUntil;
    if (reason === "extended-expiry") approval.validUntil = "2026-10-20T15:00:00Z";
    const envelope = f.signedReview(f.review);
    if (reason === "signature") envelope.signature = fixture().signedReview(f.review).signature;
    if (reason === "key") f.pins.publicKeySha256 = hash(90);
    if (reason === "owner") f.pins.ownerBindingHash = hash(90);
    if (reason === "target") f.pins.targetBindingHash = hash(90);
    expect(() => verifyManagedAdministrationReview(envelope, reason === "digest" ? hash(90) : managedDigest(envelope), f.pins, at)).toThrow();
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
