import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { managedDigest } from "./managed-claims";
import { ManagedBudgetError, managedBudgetStateSchema, managedBudgetUnitsSchema, emptyManagedBudgetUnits, managedBudgetRequestSchema, managedReleaseMonthlyCapSchema, managedCompletionAllowanceSchema, managedStandardMonthAdjustmentSchema } from "./managed-service-budget";

const hash = z.string().regex(/^[a-f0-9]{64}$/), quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const yen = z.number().int().nonnegative().max(1_000_000_000);
const source = z.object({ digest: hash, bytes: z.number().int().positive().max(128 * 1024) }).strict();
const unitNames = managedBudgetUnitsSchema.keyof();
const signature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
// A bounded ordinary release, not Issue140's completion allowance. Keeping the
// field absent on old steps preserves their canonical serialization/digests.
const managedIssue150IntegrationV1Schema = z.object({ scope: z.literal("ISSUE150_INTEGRATION_V1"),
  ownerApprovalDigest: hash, profileDigest: hash,
  approvedAt: z.literal("2026-10-17T06:41:40Z"), validUntil: z.literal("2026-10-18T06:41:40Z"),
  forwardOperationId: z.uuidv4().nullable(),
}).strict();
const managedIssue150PreflightV1Schema = z.object({ scope: z.literal("ISSUE150_INTEGRATION_PREFLIGHT_V1"),
  ownerApprovalDigest: hash, technicalGoHeadSha: commit, technicalGoTreeSha: commit, baseTreeSha: commit,
  aiExposureYen: yen.max(3000), rollbackReserveYen: yen.max(1600),
  forwardResultDigest: hash.nullable(),
}).strict();
const managedIssue150IntegrationV2Schema = managedIssue150IntegrationV1Schema.extend({
  scope: z.literal("ISSUE150_INTEGRATION_V2"), approvedAt: z.iso.datetime(),
  validUntil: z.literal("2026-10-20T14:59:00Z"),
}).refine(a => Date.parse(a.approvedAt) >= Date.parse("2026-10-19T00:00:00Z") && Date.parse(a.approvedAt) < Date.parse(a.validUntil));
// Separate pending approval scope; historical V1/V2 bounds remain unchanged.
const managedIssue150IntegrationV3Schema = managedIssue150IntegrationV1Schema.extend({
  scope: z.literal("ISSUE150_INTEGRATION_V3"), approvedAt: z.iso.datetime(),
  validUntil: z.literal("2026-10-20T14:59:00Z"),
}).refine(a => Date.parse(a.approvedAt) >= Date.parse("2026-10-19T00:00:00Z") && Date.parse(a.approvedAt) < Date.parse(a.validUntil));
// Pending V4 keeps every historical approval byte/ceiling unchanged. Admission
// still requires a fresh independently signed owner approval and preflight.
const managedIssue150IntegrationV4Schema = managedIssue150IntegrationV1Schema.extend({
  scope: z.literal("ISSUE150_INTEGRATION_V4"), approvedAt: z.iso.datetime(),
  validUntil: z.literal("2026-10-20T14:59:00Z"),
}).refine(a => Date.parse(a.approvedAt) >= Date.parse("2026-10-19T00:00:00Z") && Date.parse(a.approvedAt) < Date.parse(a.validUntil));
export const managedIssue150IntegrationSchema = z.discriminatedUnion("scope", [managedIssue150IntegrationV1Schema, managedIssue150IntegrationV2Schema, managedIssue150IntegrationV3Schema, managedIssue150IntegrationV4Schema]);
export const managedIssue150PreflightSchema = z.discriminatedUnion("scope", [managedIssue150PreflightV1Schema,
  managedIssue150PreflightV1Schema.extend({ scope: z.literal("ISSUE150_INTEGRATION_PREFLIGHT_V2"),
    aiExposureYen: yen.max(4843), rollbackReserveYen: yen.max(1400) }),
  managedIssue150PreflightV1Schema.extend({ scope: z.literal("ISSUE150_INTEGRATION_PREFLIGHT_V3"),
    aiExposureYen: yen.max(5421), rollbackReserveYen: yen.max(1400), productionNonAiReserveYen: z.literal(150) }),
  managedIssue150PreflightV1Schema.extend({ scope: z.literal("ISSUE150_INTEGRATION_PREFLIGHT_V4"),
    aiExposureYen: yen.max(5437), rollbackReserveYen: yen.max(1400), productionNonAiReserveYen: z.literal(150) })]);
export const managedIssue150ForwardResultSchema = z.object({ scope: z.literal("ISSUE150_FORWARD_RESULT_V1"),
  forwardOperationId: z.uuidv4(), forwardRequestDigest: hash, prNumber: z.number().int().positive(),
  prHeadSha: commit, baseSha: commit, mergeSha: commit, mergeTreeSha: commit, mergeParentSha: commit,
  // The signer checks actual merged PR/commit and terminal deployment metadata.
  // A failed deployment can need a revert; an unknown deployment cannot overlap.
  deployment: z.enum(["succeeded", "failed", "cancelled"]), evidenceDigests: z.array(hash).min(1).max(16),
}).strict();
/** One reviewed Local operation, including every automated trigger it causes.
 * No GitHub/Azure credentials or private records are sent to public CI. */
const releaseStepSchemaBase = z.object({ issue: z.union([z.literal(129), z.literal(139), z.literal(140), z.literal(150)]), repository: z.literal("hirokiriko/patentai-mini"),
  completionAllowance: managedCompletionAllowanceSchema.optional(),
  issue150Integration: managedIssue150IntegrationSchema.optional(),
  operationId: z.uuidv4(), kind: z.enum(["validation", "forward", "rollback"]),
  trigger: z.enum(["pr-push", "pr-open", "pr-reopen", "squash-merge", "workflow-dispatch"]),
  prNumber: z.number().int().positive().nullable(), targetRef: z.string().max(200).regex(/^refs\/heads\/(?:main|codex\/[a-zA-Z0-9_-][a-zA-Z0-9_/-]*)$/),
  remoteBeforeSha: commit.nullable(), headSha: commit, baseSha: commit, treeSha: commit,
  ciWorkflowSha256: hash, deployWorkflowSha256: hash, preflightDigest: hash, pricingDigest: hash,
  reservationYen: yen.refine(v => v > 0 && v <= 30_000),
}).strict().refine(s => {
  if ((s.issue === 140) !== (s.completionAllowance !== undefined)) return false;
  if ((s.issue === 150) !== (s.issue150Integration !== undefined)) return false;
  if (s.issue150Integration) {
    const rollback = s.issue150Integration.forwardOperationId !== null;
    if (s.kind === "forward" ? rollback || s.trigger !== "squash-merge" : !rollback) return false;
    if (s.kind === "rollback" && s.trigger !== "squash-merge") return false;
    if (s.kind === "validation" && !["pr-push", "pr-open"].includes(s.trigger)) return false;
    if (s.kind === "validation" && !s.targetRef.startsWith("refs/heads/codex/issue-150-revert-")) return false;
    if (s.kind === "validation" && (s.prNumber !== null || s.trigger === "pr-push" && s.remoteBeforeSha !== null)) return false;
  }
  if (s.targetRef.includes("//") || s.targetRef.endsWith("/")) return false;
  if (s.kind === "validation") return s.targetRef.startsWith("refs/heads/codex/") &&
    ["pr-push", "pr-open", "pr-reopen"].includes(s.trigger) &&
    (s.trigger === "pr-open" ? s.prNumber === null && s.remoteBeforeSha === s.headSha :
      s.trigger === "pr-push" || s.prNumber !== null);
  return s.targetRef === "refs/heads/main" && s.remoteBeforeSha === s.baseSha &&
    (s.trigger === "squash-merge" ? s.prNumber !== null : s.trigger === "workflow-dispatch" && s.prNumber === null && s.headSha === s.baseSha);
});
export const managedReleaseStepSchema = releaseStepSchemaBase.safeExtend({ issue: z.union([z.literal(129), z.literal(140), z.literal(150)]) });
const historicalIssue139ReleaseStepSchema = releaseStepSchemaBase.safeExtend({ issue: z.literal(139) });
export type ManagedReleaseStep = z.infer<typeof managedReleaseStepSchema>;
export function managedReleaseBudgetRequest(value: unknown, targetBindingHash: string, ownerBindingHash: string) {
  const step = managedReleaseStepSchema.parse(value);
  return managedBudgetRequestSchema.parse({ operationId: step.operationId,
    scope: step.issue === 140 || step.issue === 150 ? "standard" : "release",
    profileDigest: step.issue150Integration?.profileDigest ?? step.completionAllowance?.profileDigest ?? null,
    requestDigest: managedDigest({ schema: 1, purpose: "MANAGED_WATCH_RELEASE_STEP_V1", targetBindingHash: hash.parse(targetBindingHash),
      ownerBindingHash: hash.parse(ownerBindingHash), step }),
    kind: step.kind === "validation" ? "validation" : "deploy", cases: [], pricingDigest: step.pricingDigest,
    reservationYen: step.reservationYen, units: { ...emptyManagedBudgetUnits(),
      ...(step.kind === "validation" ? {} : { [step.kind]: 1 }) } });
}
// These statements are issued by the separate Local administration process only
// after checking the exact terminal receipts/usage and their attribution. They
// are never accepted as raw fields of a business start or an HTTP request.
export const managedSettlementReviewSchema = z.object({ schema: z.literal(1),
  purpose: z.literal("MANAGED_WATCH_SETTLEMENT_REVIEW_V1"), targetBindingHash: hash, ownerBindingHash: hash,
  operationId: z.uuidv4(), requestDigest: hash, pricingDigest: hash,
  sequence: quantity.refine(v => v > 0), previousProofDigest: hash.nullable(),
  issuedAt: z.iso.datetime(), validUntil: z.iso.datetime(),
  sources: z.array(source).min(1).max(16),
  finalizedUnits: managedBudgetUnitsSchema.partial().strict(),
  unitEvidence: z.array(z.object({ unit: unitNames, sourceDigest: hash }).strict()).max(9),
  cost: z.object({ operationId: z.uuidv4(), sourceDigest: hash, observedYen: yen,
    finalYen: yen.nullable() }).strict().nullable(),
}).strict();
export const managedSignedSettlementSchema = z.object({ review: managedSettlementReviewSchema,
  signature }).strict();
export const managedAdministrationReviewSchema = z.object({ schema: z.literal(1),
  purpose: z.literal("MANAGED_WATCH_ADMINISTRATION_REVIEW_V1"), targetBindingHash: hash, ownerBindingHash: hash,
  sequence: quantity.refine(v => v > 0), previousReviewDigest: hash.nullable(), expectedStateDigest: hash.nullable(),
  issuedAt: z.iso.datetime(), validUntil: z.iso.datetime(), sources: z.array(source).min(1).max(16),
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("open"), state: managedBudgetStateSchema }).strict(),
    z.object({ kind: z.literal("month"), processingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
      standardMonthAdjustment: managedStandardMonthAdjustmentSchema.optional(),
      baseYen: yen, pools: z.object({ remaining: yen, storage: yen, recovery: yen }).strict(), pricingDigest: hash, releaseTailYen: yen,
      reviewedOperationIds: z.array(z.uuidv4()).max(768).refine(ids => new Set(ids).size === ids.length),
      releaseMonthlyCapYen: managedReleaseMonthlyCapSchema.optional(), completionAllowance: managedCompletionAllowanceSchema.optional() }).strict()
      .refine(a => (!a.standardMonthAdjustment || a.standardMonthAdjustment.month === a.processingMonth) &&
        (a.releaseMonthlyCapYen === undefined || a.processingMonth === "2026-09") &&
        (!a.completionAllowance || (a.processingMonth === a.completionAllowance.month && a.releaseMonthlyCapYen === undefined))),
    z.object({ kind: z.literal("activate"), profileDigest: hash, goEvidenceDigest: hash, measurementDigest: hash, pricingDigest: hash }).strict(),
    z.object({ kind: z.literal("release-start"), step: managedReleaseStepSchema }).strict(),
  ]),
}).strict();
export const managedSignedAdministrationSchema = z.object({ review: managedAdministrationReviewSchema, signature }).strict();
const historicalSignedAdministrationSchema = managedSignedAdministrationSchema.extend({
  review: managedAdministrationReviewSchema.extend({ action: z.union([
    managedAdministrationReviewSchema.shape.action,
    z.object({ kind: z.literal("release-start"), step: historicalIssue139ReleaseStepSchema }).strict(),
  ]) }),
});
export type ManagedAdministrationReview = z.infer<typeof managedAdministrationReviewSchema>;
export type ManagedSettlementReview = z.infer<typeof managedSettlementReviewSchema>;
export type ManagedBudgetEvidencePins = Readonly<{ publicKeySpkiBase64: string; publicKeySha256: string;
  ownerBindingHash: string; targetBindingHash: string; productionGoDigest?: string }>;
const check = (value: unknown) => { if (!value) throw new ManagedBudgetError(); };

/** Public verification key and its independently installed pin. No signing key
 * is loaded by app/Job or read from stdin, Blob, or a submitted profile. */
export function managedBudgetEvidencePins(env: Record<string, string | undefined> = process.env): ManagedBudgetEvidencePins {
  try { const p = { publicKeySpkiBase64: env.MANAGED_BUDGET_REVIEW_PUBLIC_KEY ?? "",
    publicKeySha256: hash.parse(env.MANAGED_BUDGET_REVIEW_KEY_SHA256),
    ownerBindingHash: hash.parse(env.MANAGED_BUDGET_OWNER_SHA256), targetBindingHash: hash.parse(env.MANAGED_BUDGET_TARGET_SHA256),
    ...(env.MANAGED_BUDGET_PRODUCTION_GO_SHA256 ? { productionGoDigest: hash.parse(env.MANAGED_BUDGET_PRODUCTION_GO_SHA256) } : {}) };
    publicKey(p); return p;
  } catch { throw new ManagedBudgetError(); }
}
function verifyReview(envelope: { review: { targetBindingHash: string; ownerBindingHash: string; issuedAt: string; validUntil: string;
  sources: Array<z.infer<typeof source>> }; signature: string }, expectedDigest: string, pins: ManagedBudgetEvidencePins,
  at: Date, requireFresh: boolean) {
  const r = envelope.review;
  check(managedDigest(envelope) === hash.parse(expectedDigest));
  check(r.targetBindingHash === hash.parse(pins.targetBindingHash) && r.ownerBindingHash === hash.parse(pins.ownerBindingHash));
  check(verify(null, Buffer.from(managedDigest(r), "hex"), publicKey(pins), Buffer.from(envelope.signature, "base64")));
  const now = at.getTime(), issued = Date.parse(r.issuedAt), until = Date.parse(r.validUntil);
  check(Number.isFinite(now) && issued <= now && until > issued && until - issued <= 7 * 24 * 60 * 60_000);
  check(!requireFresh || now < until);
  check(new Set(r.sources.map(s => s.digest)).size === r.sources.length);
}
export function verifyManagedAdministrationReview(value: unknown, expectedDigest: string, pins: ManagedBudgetEvidencePins, at: Date,
  requireFresh = true) {
  try {
    const envelope = managedSignedAdministrationSchema.parse(value), r = envelope.review;
    verifyReview(envelope, expectedDigest, pins, at, requireFresh);
    const sources = new Set(r.sources.map(s => s.digest));
    if (r.action.kind === "activate") check(r.action.goEvidenceDigest === hash.parse(pins.productionGoDigest) &&
      [r.action.goEvidenceDigest, r.action.measurementDigest, r.action.pricingDigest].every(d => sources.has(d)));
    if (r.action.kind === "open") check(r.sequence === 1 && r.previousReviewDigest === null && r.expectedStateDigest === null &&
      r.action.state.administration.length === 0 && r.action.state.activeProfileDigest === null &&
      r.action.state.targetBindingHash === pins.targetBindingHash && sources.has(r.action.state.openingEvidenceDigest) &&
      r.action.state.plans.every(p => sources.has(p.pricingDigest)));
    else check(r.expectedStateDigest !== null);
    if (r.action.kind === "month") check(sources.has(r.action.pricingDigest));
    if (r.action.kind === "month" && r.action.standardMonthAdjustment) {
      const a = r.action.standardMonthAdjustment;
      check(sources.has(a.ownerApprovalDigest) &&
        new Date(Date.parse(r.issuedAt) + 9 * 60 * 60_000).toISOString().slice(0, 7) === a.month);
    }
    const completion = r.action.kind === "month" ? r.action.completionAllowance :
      r.action.kind === "release-start" ? r.action.step.completionAllowance : undefined;
    if (completion) check(sources.has(completion.ownerApprovalDigest) &&
      new Date(Date.parse(r.issuedAt) + 9 * 60 * 60_000).toISOString().slice(0, 7) === completion.month &&
      Date.parse(r.validUntil) <= Date.parse(completion.validUntil));
    if (r.action.kind === "release-start") check(sources.has(r.action.step.pricingDigest) && sources.has(r.action.step.preflightDigest) &&
      Date.parse(r.validUntil) - Date.parse(r.issuedAt) <= 15 * 60_000);
    if (r.action.kind === "release-start" && r.action.step.issue150Integration) {
      const a = r.action.step.issue150Integration;
      check(sources.has(a.ownerApprovalDigest) && Date.parse(r.issuedAt) >= Date.parse(a.approvedAt) &&
        Date.parse(r.validUntil) <= Date.parse(a.validUntil));
    }
    return envelope;
  } catch { throw new ManagedBudgetError(); }
}
/** Read-only historical authentication. A past activation keeps its original GO
 * binding; it is not reapplied against today's production GO pin. */
export function verifyManagedAdministrationHistory(value: unknown, expectedDigest: string, pins: ManagedBudgetEvidencePins, at: Date) {
  try {
    const envelope = historicalSignedAdministrationSchema.parse(value);
    verifyReview(envelope, expectedDigest, pins, at, false);
    return envelope;
  } catch { throw new ManagedBudgetError(); }
}
function publicKey(p: ManagedBudgetEvidencePins) {
  check(/^[A-Za-z0-9+/]{59}=$/.test(p.publicKeySpkiBase64));
  const der = Buffer.from(p.publicKeySpkiBase64, "base64");
  check(createHash("sha256").update(der).digest("hex") === hash.parse(p.publicKeySha256));
  const key = createPublicKey({ key: der, type: "spki", format: "der" });
  check(key.asymmetricKeyType === "ed25519"); return key;
}
export function verifyManagedSettlementReview(value: unknown, expectedDigest: string, pins: ManagedBudgetEvidencePins, at: Date,
  requireFresh = true) {
  try {
    const envelope = managedSignedSettlementSchema.parse(value), r = envelope.review;
    verifyReview(envelope, expectedDigest, pins, at, requireFresh);
    const digests = new Set(r.sources.map(s => s.digest));
    check(new Set(r.unitEvidence.map(e => e.unit)).size === r.unitEvidence.length);
    check(r.unitEvidence.every(e => digests.has(e.sourceDigest) && r.finalizedUnits[e.unit] !== undefined));
    check(Object.keys(r.finalizedUnits).length === r.unitEvidence.length);
    if (r.cost) { check(r.cost.operationId === r.operationId && digests.has(r.cost.sourceDigest));
      check(r.cost.finalYen === null || (r.cost.finalYen >= r.cost.observedYen &&
        Object.keys(r.finalizedUnits).length === Object.keys(managedBudgetUnitsSchema.shape).length)); }
    check(r.unitEvidence.length > 0 || r.cost !== null);
    return envelope;
  } catch { throw new ManagedBudgetError(); }
}

export function managedSettlementProof(review: ManagedSettlementReview, evidenceDigest: string) {
  return { operationId: review.operationId, requestDigest: review.requestDigest, sequence: review.sequence,
    evidenceDigest: hash.parse(evidenceDigest), knownUnits: review.finalizedUnits,
    ...(review.cost ? { observedYen: review.cost.observedYen,
      ...(review.cost.finalYen === null ? {} : { actualYen: review.cost.finalYen }) } : {}) };
}
