import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { MANAGED_SERVICE_KEY, managedReleaseCaps, emptyManagedBudgetUnits, managedBudgetStateSchema,
  managedBudgetForecast, reserveManagedBudget, claimManagedBudgetPhase, confirmManagedBudgetStage,
  markManagedBudgetUnknown, settleManagedBudget as settleSequence, setManagedMonthPlan, activateManagedBudgetProfile,
  managedCompletionAllowanceSchema, managedStandardMonthAdjustmentSchema, checkManagedCompletionBudget, checkManagedStandardBudget, checkManagedExecutionBudget,
  type ManagedBudgetState, type ManagedBudgetProfile } from "./managed-service-budget";
import { validateManagedBudgetState } from "./managed-service-budget";

const digest = (n: number) => n.toString(16).padStart(64, "0");
const clock = (date = "2026-09-23T00:00:00.000Z", maximumActionMs = 120 * 60_000) => ({ blobDate: new Date(date), maximumActionMs });
function settleManagedBudget(s: ManagedBudgetState, proof: Omit<Parameters<typeof settleSequence>[1], "sequence">, now: ReturnType<typeof clock>) {
  const o = s.operations.find(o => o.operationId === proof.operationId)!;
  const sequence = o.settlements.find(p => p.evidenceDigest === proof.evidenceDigest)?.sequence ?? o.lastProofSequence + 1;
  return settleSequence(s, { ...proof, sequence }, now);
}
function state(): ManagedBudgetState { return managedBudgetStateSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY,
  targetBindingHash: digest(1), activeProfileDigest: null, cases: [], lastTrustedAt: "2026-09-22T00:00:00.000Z",
  releaseTailYen: 20_000, legacyUnknownYen: 2000, openingEvidenceDigest: digest(2), administration: [],
  plans: [{ month: "2026-09", baseYen: 10_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 }, pricingDigest: digest(4), evidenceDigests: [digest(3)] }], operations: [] }); }
function request(overrides: Record<string, unknown> = {}) { return { operationId: randomUUID(), requestDigest: managedDigest(randomUUID()),
  scope: "release", kind: "import", profileDigest: null, pricingDigest: digest(4), cases: [1], reservationYen: 1000,
  units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, packages: 1, bytes: 1024 }, ...overrides }; }
function profile(): ManagedBudgetProfile { return { schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: digest(1),
  ownerBindingHash: digest(10), companyKey: "FICTIONAL_COMPANY", cases: [1], monthlyCapYen: 30_000,
  monthlyUnits: { ...managedReleaseCaps }, pricingDigest: digest(4), measurementDigest: digest(11), goEvidenceDigest: digest(12) }; }
function activate(s: ManagedBudgetState, p: ManagedBudgetProfile, date = clock()) {
  return activateManagedBudgetProfile(s, p, { profileDigest: managedDigest(p), goEvidenceDigest: p.goEvidenceDigest,
    measurementDigest: p.measurementDigest, pricingDigest: p.pricingDigest }, date);
}
function nextMonth(s: ManagedBudgetState, date = "2026-09-30T15:00:01.000Z") {
  return setManagedMonthPlan(s, { baseYen: 10_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 },
    pricingDigest: digest(4), evidenceDigest: digest(8), releaseTailYen: s.releaseTailYen }, clock(date));
}
function completionFixture() {
  const p = profile(), now = clock("2026-10-01T00:00:00.000Z");
  const old = request({ kind: "deploy", reservationYen: 100,
    units: { ...emptyManagedBudgetUnits(), jobs: 24, minutes: 2880, forward: 8 } });
  const reserved = reserveManagedBudget(state(), old, null, clock()).state;
  const september = settleManagedBudget(reserved, { operationId: old.operationId, requestDigest: old.requestDigest,
    evidenceDigest: digest(300), knownUnits: { forward: 8 } }, clock());
  const s = activate(nextMonth(september), p, now);
  const allowance = managedCompletionAllowanceSchema.parse({ scope: "ISSUE140_COMPLETION_V2", issue: 140, month: "2026-10",
    ownerApprovalDigest: digest(301), profileDigest: managedDigest(p), monthlyCapYen: 32_000,
    cumulativeUnits: { ...managedReleaseCaps, jobs: 26, minutes: 3120, forward: 10 }, validUntil: "2026-10-31T15:00:00.000Z" });
  const input = { baseYen: 19_000, pools: { remaining: 9000, storage: 1000, recovery: 100 }, pricingDigest: p.pricingDigest,
    evidenceDigest: digest(302), releaseTailYen: s.releaseTailYen, completionAllowance: allowance };
  const allowed = setManagedMonthPlan(s, input, now);
  const r = request({ scope: "standard", profileDigest: managedDigest(p), cases: [1] });
  return { p, now, september, s, allowance, input, allowed, r };
}
it("checks ordinary cost and every ordinary unit even under an installed completion allowance", () => {
  const f = completionFixture();
  expect(() => checkManagedStandardBudget(f.allowed, f.p, f.now)).toThrow(); // 31,200 exceeds the ordinary 30,000
  const s = structuredClone(f.allowed); s.plans[1].baseYen = 10_000;
  checkManagedStandardBudget(s, f.p, f.now);
  for (const unit of Object.keys(emptyManagedBudgetUnits()) as Array<keyof typeof f.p.monthlyUnits>) {
    const original = structuredClone(s), p = { ...f.p, monthlyUnits: { ...f.p.monthlyUnits, [unit]: 0 } };
    original.activeProfileDigest = managedDigest(p);
    // Unresolved prior-month units carry forward; no historical use is dropped.
    original.operations[0].knownUnits = {}; original.operations[0].units[unit] = 1;
    const o = original.operations[0];
    o.intentDigest = managedDigest({ operationId: o.operationId, requestDigest: o.requestDigest, scope: o.scope,
      kind: o.kind, profileDigest: o.profileDigest, pricingDigest: o.pricingDigest, cases: o.cases, reservationYen: o.reservationYen, units: o.units });
    original.plans[1].completionAllowance!.profileDigest = managedDigest(p);
    const positive = structuredClone(original), allowed = { ...p, monthlyUnits: { ...p.monthlyUnits, [unit]: 1 } };
    positive.activeProfileDigest = managedDigest(allowed);
    positive.plans[1].completionAllowance!.profileDigest = managedDigest(allowed);
    checkManagedStandardBudget(positive, allowed, f.now);
    expect(() => checkManagedStandardBudget(original, p, f.now)).toThrow();
  }
});
function standardAdjustment(p: ManagedBudgetProfile) {
  return managedStandardMonthAdjustmentSchema.parse({ scope: "ISSUE150_STANDARD_MONTH_V1", month: "2026-10",
    ownerApprovalDigest: digest(400), profileDigest: managedDigest(p), monthlyCapYen: 38331, jobs: 25, minutes: 3000, forward: 9 });
}
it("admits only the repair month supplement while retaining unresolved prior-month deployment units", () => {
  const f = completionFixture(), unresolved = structuredClone(f.allowed);
  unresolved.operations[0].knownUnits = {};
  const ordinary = setManagedMonthPlan(unresolved, { ...f.input, standardMonthAdjustment: standardAdjustment(f.p) }, f.now);
  const deployment = () => ({ ...f.r, operationId: randomUUID(), requestDigest: managedDigest(randomUUID()),
    kind: "deploy", reservationYen: 1, units: { ...emptyManagedBudgetUnits(), forward: 1 } });
  const ninth = reserveManagedBudget(ordinary, deployment(), f.p, f.now).state;
  expect(() => reserveManagedBudget(ninth, deployment(), f.p, f.now)).toThrow();
  const priorPlan = ninth.plans.find(p => p.month === "2026-10")!;
  const supplement = managedStandardMonthAdjustmentSchema.parse({ ...standardAdjustment(f.p),
    scope: "ISSUE150_REPAIR_STANDARD_MONTH_V1", forward: 10,
    repairEpochDigest: digest(420), priorPlanDigest: managedDigest(priorPlan) });
  if (supplement.scope !== "ISSUE150_REPAIR_STANDARD_MONTH_V1") throw new Error("repair supplement required");
  const input = { ...f.input, evidenceDigest: digest(421), standardMonthAdjustment: supplement };
  const repaired = setManagedMonthPlan(ninth, input, f.now);
  const tenth = reserveManagedBudget(repaired, deployment(), f.p, f.now).state;
  expect(tenth.operations.slice(0, ninth.operations.length)).toEqual(ninth.operations);
  expect(tenth.legacyUnknownYen).toBe(ninth.legacyUnknownYen);
  expect(() => reserveManagedBudget(tenth, deployment(), f.p, f.now)).toThrow();
  for (const change of [{ forward: 11 }, { jobs: 26 }, { minutes: 3001 }, { monthlyCapYen: 38332 }, { month: "2026-11" }]) {
    expect(() => managedStandardMonthAdjustmentSchema.parse({ ...supplement, ...change })).toThrow();
  }
  expect(() => managedStandardMonthAdjustmentSchema.parse({ ...standardAdjustment(f.p), forward: 10 })).toThrow();
  expect(() => setManagedMonthPlan(ninth, { ...input, standardMonthAdjustment: { ...supplement, priorPlanDigest: digest(999) } }, f.now)).toThrow();
  expect(() => setManagedMonthPlan(ninth, { ...input, baseYen: input.baseYen - 1 }, f.now)).toThrow();
  expect(() => setManagedMonthPlan(ninth, { ...input, reviewedOperationIds: [ninth.operations[0].operationId] }, f.now)).toThrow();
});
it("applies only the signed ordinary month limits and keeps unknown usage and base caps", () => {
  const f = completionFixture(), adjustment = standardAdjustment(f.p);
  const s = setManagedMonthPlan(f.allowed, { ...f.input, standardMonthAdjustment: adjustment }, f.now);
  checkManagedStandardBudget(s, f.p, f.now);
  expect(s.operations).toEqual(f.allowed.operations);
  expect(s.legacyUnknownYen).toBe(f.allowed.legacyUnknownYen);
  expect(s.plans[0]).toEqual(f.allowed.plans[0]);
  expect(s.plans[1].completionAllowance).toEqual(f.allowance);
  expect(f.p.monthlyCapYen).toBe(30000);
  expect(managedReleaseCaps).toMatchObject({ jobs: 24, minutes: 2880, forward: 8 });
  const one = reserveManagedBudget(s, f.r, f.p, f.now).state;
  expect(() => reserveManagedBudget(one, { ...f.r, operationId: randomUUID(), requestDigest: digest(401) }, f.p, f.now)).toThrow();
  for (const unit of ["starts", "normal", "fast", "packages", "bytes", "rollback"] as const) {
    const next = { ...f.r, operationId: randomUUID(), requestDigest: digest(402), units: { ...emptyManagedBudgetUnits(), [unit]: f.p.monthlyUnits[unit] + 1 } };
    expect(() => reserveManagedBudget(s, next, f.p, f.now)).toThrow();
  }
  const bad = structuredClone(s); bad.plans[1].standardMonthAdjustment!.profileDigest = digest(999);
  expect(() => checkManagedStandardBudget(bad, f.p, f.now)).toThrow();
  const expired = structuredClone(s); expired.plans[1].completionAllowance!.validUntil = "2026-10-01T01:00:00Z";
  expect(() => checkManagedStandardBudget(expired, f.p, f.now)).toThrow();
});
function novemberRepairFixture() {
  const f = completionFixture(), unresolved = structuredClone(f.allowed);
  unresolved.operations[0].knownUnits = {};
  const ordinary = setManagedMonthPlan(unresolved, { ...f.input,
    standardMonthAdjustment: standardAdjustment(f.p) }, f.now);
  const october = reserveManagedBudget(ordinary, { ...f.r, kind: "deploy", reservationYen: 100,
    units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, forward: 1 } }, f.p, f.now).state;
  const p = { ...f.p, pricingDigest: digest(501), goEvidenceDigest: digest(502) };
  const now = clock("2026-11-05T00:00:00Z"), prior = october.plans[1];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({
    scope: "ISSUE150_NOVEMBER_REPAIR_MONTH_V1", month: "2026-11", ownerApprovalDigest: digest(503),
    profileDigest: managedDigest(p), monthlyCapYen: 53607, jobs: 25, minutes: 3000, forward: 10,
    repairEpochDigest: digest(504), priorPlanDigest: managedDigest(prior), validUntil: "2026-11-06T00:00:00Z",
    executionEarmark: { forecastBaseYen: prior.baseYen, productionAiYen: 1238, imageRetentionYen: 1115 } });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_REPAIR_MONTH_V1") throw new Error("November supplement required");
  const input = { baseYen: prior.baseYen + 2353, pools: { remaining: 6547, storage: 1000, recovery: 100 },
    pricingDigest: p.pricingDigest, evidenceDigest: digest(505), releaseTailYen: october.releaseTailYen,
    standardMonthAdjustment: adjustment };
  return { f, october, p, now, input, adjustment };
}
it("rolls only unreserved pools into November while retaining every old operation and unit", () => {
  const f = novemberRepairFixture(), before = structuredClone(f.october);
  const planned = setManagedMonthPlan(f.october, f.input, f.now);
  const active = activate(planned, f.p, f.now);
  checkManagedStandardBudget(active, f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.plans.slice(0, 2)).toEqual(before.plans);
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(managedBudgetForecast(active, "2026-11")).toBe(31_200);
  expect(active.plans[2].baseYen - before.plans[1].baseYen).toBe(2353);
  expect(active.plans[2].standardMonthAdjustment).toMatchObject({ executionEarmark: {
    productionAiYen: 1238, imageRetentionYen: 1115 } });
  const deploy = () => request({ scope: "standard", kind: "deploy", profileDigest: managedDigest(f.p),
    pricingDigest: f.p.pricingDigest, reservationYen: 100, units: { ...emptyManagedBudgetUnits(), forward: 1 } });
  const tenth = reserveManagedBudget(active, deploy(), f.p, f.now).state;
  expect(() => reserveManagedBudget(tenth, deploy(), f.p, f.now)).toThrow();
  expect(tenth.operations.slice(0, before.operations.length)).toEqual(before.operations);
  const restored = setManagedMonthPlan(tenth, { ...f.input, evidenceDigest: digest(506),
    standardMonthAdjustment: { ...f.adjustment, forward: 9, priorPlanDigest: managedDigest(tenth.plans[2]) } }, f.now);
  expect(restored.operations).toEqual(tenth.operations);
  expect(restored.plans[2].standardMonthAdjustment).toMatchObject({ executionEarmark: f.adjustment.executionEarmark });
  expect(() => checkManagedStandardBudget(restored, f.p, f.now)).toThrow();
});
it("rejects replenishment, old exceptions, stale links and a financial rewrite during November repair", () => {
  const f = novemberRepairFixture();
  for (const patch of [
    { pools: { ...f.input.pools, remaining: 9000 } },
    { pools: { ...f.input.pools, remaining: 8900 } },
    { baseYen: f.input.baseYen - 1 },
    { completionAllowance: f.f.allowance },
    { releaseTailYen: f.input.releaseTailYen + 1 },
    { reviewedOperationIds: [f.october.operations[0].operationId] },
    { standardMonthAdjustment: { ...f.adjustment, priorPlanDigest: digest(999) } },
    { standardMonthAdjustment: { ...f.adjustment, executionEarmark: {
      ...f.adjustment.executionEarmark, forecastBaseYen: f.adjustment.executionEarmark.forecastBaseYen - 1 } } },
  ]) expect(() => setManagedMonthPlan(f.october, { ...f.input, ...patch }, f.now)).toThrow();
  const s = setManagedMonthPlan(f.october, f.input, f.now);
  expect(() => setManagedMonthPlan(s, { ...f.input, standardMonthAdjustment: undefined }, f.now)).toThrow();
  const linked = { ...f.input, standardMonthAdjustment: { ...f.adjustment, priorPlanDigest: managedDigest(s.plans[2]) } };
  for (const patch of [{ baseYen: f.input.baseYen + 1 }, { pools: { ...f.input.pools, storage: 999 } },
    { standardMonthAdjustment: { ...linked.standardMonthAdjustment, monthlyCapYen: 53606 } }]) {
    expect(() => setManagedMonthPlan(s, { ...linked, ...patch }, f.now)).toThrow();
  }
});
it("bounds the November supplement and rejects execution crossing its expiry", () => {
  const f = novemberRepairFixture();
  for (const patch of [{ month: "2026-12" }, { monthlyCapYen: 53608 }, { forward: 11 },
    { jobs: 26 }, { minutes: 3001 }, { validUntil: "2026-12-01T00:00:00Z" },
    { executionEarmark: undefined },
    { executionEarmark: { ...f.adjustment.executionEarmark, productionAiYen: 1237 } },
    { executionEarmark: { ...f.adjustment.executionEarmark, imageRetentionYen: 1114 } }]) {
    expect(() => managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment, ...patch })).toThrow();
  }
  const active = activate(setManagedMonthPlan(f.october, f.input, f.now), f.p, f.now);
  expect(() => checkManagedStandardBudget(active, f.p, clock("2026-11-05T22:00:00Z"))).toThrow();
  expect(() => checkManagedExecutionBudget(active, f.p, clock("2026-11-06T00:00:00Z", 1))).toThrow();
  for (const p of [null, undefined]) {
    expect(() => checkManagedExecutionBudget(active, p, f.now)).toThrow();
    expect(() => checkManagedExecutionBudget(active, p, clock("2026-11-06T00:00:00Z", 1))).toThrow();
  }
  // Keep this fixture below the generic release ceiling so rejection cannot
  // be explained by the unrelated 30,000-yen check.
  const lowCost = structuredClone(active); lowCost.plans[2].baseYen = 10_000;
  const release = request({ kind: "validation", pricingDigest: f.p.pricingDigest, units: emptyManagedBudgetUnits() });
  const generic = structuredClone(lowCost); delete generic.plans[2].standardMonthAdjustment;
  expect(() => reserveManagedBudget(generic, release, null, f.now)).not.toThrow();
  expect(() => reserveManagedBudget(lowCost, release, null, f.now)).toThrow();
  expect(() => checkManagedStandardBudget(active, f.f.p, f.now)).toThrow();
});
function reviewFailureRepairFixture() {
  const f = novemberRepairFixture();
  const active = activate(setManagedMonthPlan(f.october, f.input, f.now), f.p, f.now);
  const deployment = () => request({ scope: "standard", kind: "deploy", profileDigest: managedDigest(f.p),
    pricingDigest: f.p.pricingDigest, reservationYen: 100, units: { ...emptyManagedBudgetUnits(), forward: 1 } });
  const previous = reserveManagedBudget(active, deployment(), f.p, f.now).state;
  previous.operations[0].unknown = true;
  const p = { ...f.p, goEvidenceDigest: digest(601) }, old = previous.plans[2];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment,
    scope: "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1", monthlyCapYen: 70000, forward: 11,
    ownerApprovalDigest: digest(602), repairEpochDigest: digest(603),
    priorPlanDigest: managedDigest(old), priorProfileDigest: managedDigest(f.p),
    profileDigest: managedDigest(p), validUntil: "2026-11-07T00:00:00Z",
    executionEarmark: { ...f.adjustment.executionEarmark, additionalProductionAiYen: 1238, additionalImageRetentionYen: 1115 } });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1") throw Error("review repair required");
  const now = clock("2026-11-06T12:00:00Z");
  const input = { ...f.input, baseYen: old.baseYen + 2353, evidenceDigest: digest(604), standardMonthAdjustment: adjustment };
  return { f, previous, p, adjustment, now, input, deployment };
}
it("adds one new AI/image hold without clearing the failed trial, unknowns or old units", () => {
  const f = reviewFailureRepairFixture(), before = structuredClone(f.previous);
  const planned = setManagedMonthPlan(f.previous, f.input, f.now), active = activate(planned, f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.plans.slice(0, 2)).toEqual(before.plans.slice(0, 2));
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(active.plans[2].pools).toEqual(before.plans[2].pools);
  expect(managedBudgetForecast(active, "2026-11") - managedBudgetForecast(before, "2026-11")).toBe(2353);
  const deploy = () => ({ ...f.deployment(), profileDigest: managedDigest(f.p) });
  const eleventh = reserveManagedBudget(active, deploy(), f.p, f.now).state;
  expect(() => reserveManagedBudget(eleventh, deploy(), f.p, f.now)).toThrow();
  const stopped = setManagedMonthPlan(eleventh, { ...f.input, standardMonthAdjustment: { ...f.adjustment,
    forward: 10, priorPlanDigest: managedDigest(eleventh.plans[2]), priorProfileDigest: managedDigest(f.p) } }, f.now);
  expect(stopped.operations).toEqual(eleventh.operations);
  expect(stopped.plans[2].baseYen).toBe(active.plans[2].baseYen);
  expect(stopped.plans[2].standardMonthAdjustment?.scope).toBe("ISSUE150_NOVEMBER_REVIEW_FAILURE_REPAIR_V1");
  expect(() => checkManagedStandardBudget(stopped, f.p, f.now)).toThrow();
});
it("rejects stale plan/profile, reused approval, altered holds, pools and history in the new repair", () => {
  const f = reviewFailureRepairFixture();
  for (const change of [
    { priorPlanDigest: digest(999) }, { priorProfileDigest: digest(999) },
    { ownerApprovalDigest: f.f.adjustment.ownerApprovalDigest }, { repairEpochDigest: f.f.adjustment.repairEpochDigest },
    { executionEarmark: { ...f.adjustment.executionEarmark, forecastBaseYen: f.adjustment.executionEarmark.forecastBaseYen - 1 } },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, standardMonthAdjustment: { ...f.adjustment, ...change } }, f.now)).toThrow();
  for (const change of [
    { baseYen: f.input.baseYen - 1 }, { baseYen: f.input.baseYen + 1 },
    { pools: { ...f.input.pools, remaining: f.input.pools.remaining + 1 } },
    { pools: { ...f.input.pools, recovery: f.input.pools.recovery - 1 } },
    { releaseTailYen: f.input.releaseTailYen - 1 }, { completionAllowance: f.f.f.allowance },
    { releaseMonthlyCapYen: 40000 }, { reviewedOperationIds: [f.previous.operations[0].operationId] },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, ...change }, f.now)).toThrow();
});
it("cannot add the hold twice, remove it, downgrade scope, or extend the same repair epoch", () => {
  const f = reviewFailureRepairFixture(), planned = setManagedMonthPlan(f.previous, f.input, f.now);
  const linked = { ...f.input, standardMonthAdjustment: { ...f.adjustment, priorPlanDigest: managedDigest(planned.plans[2]) } };
  // A stopped activation may return the target profile to the still-active old
  // profile, without pretending that the unactivated target was ever active.
  const stopped = setManagedMonthPlan(planned, { ...linked, standardMonthAdjustment: {
    ...linked.standardMonthAdjustment, profileDigest: managedDigest(f.f.p), forward: 10 } }, f.now);
  expect(stopped.plans[2].baseYen).toBe(planned.plans[2].baseYen);
  expect(stopped.operations).toEqual(planned.operations);
  checkManagedStandardBudget(stopped, f.f.p, f.now);
  for (const change of [
    { baseYen: f.input.baseYen + 2353 }, { baseYen: f.input.baseYen - 2353 },
    { standardMonthAdjustment: undefined }, { standardMonthAdjustment: f.f.adjustment },
    ...[{ validUntil: "2026-11-08T00:00:00Z" }, { ownerApprovalDigest: digest(700) }, { repairEpochDigest: digest(701) },
      { priorProfileDigest: managedDigest(f.p) }].map(p => ({ standardMonthAdjustment: { ...linked.standardMonthAdjustment, ...p } })),
  ]) expect(() => setManagedMonthPlan(planned, { ...linked, ...change }, f.now)).toThrow();
});
it("bounds new repair cost, holds and units and requires the active profile before the deadline", () => {
  const f = reviewFailureRepairFixture();
  for (const change of [
    { monthlyCapYen: 70001 }, { monthlyCapYen: 69999 }, { forward: 12 }, { forward: 9 }, { jobs: 26 }, { minutes: 3001 },
    { month: "2026-12" }, { validUntil: "2026-12-01T00:00:00Z" }, { priorProfileDigest: undefined },
    ...["productionAiYen","imageRetentionYen","additionalProductionAiYen","additionalImageRetentionYen"].map(key => ({
      executionEarmark: { ...f.adjustment.executionEarmark, [key]: 0 } })),
  ]) expect(() => managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment, ...change })).toThrow();
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  checkManagedExecutionBudget(active, f.p, f.now);
  for (const p of [null, undefined, f.f.p]) expect(() => checkManagedExecutionBudget(active, p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(active, f.p, clock("2026-11-06T22:00:00Z"))).toThrow();
  expect(() => checkManagedStandardBudget(active, f.p, clock("2026-11-07T00:00:00Z", 1))).toThrow();
  const atCap = structuredClone(active); atCap.plans[2].baseYen += 70000 - managedBudgetForecast(atCap, "2026-11");
  checkManagedStandardBudget(atCap, f.p, f.now);
  atCap.plans[2].baseYen++;
  expect(() => checkManagedStandardBudget(atCap, f.p, f.now)).toThrow();
});
function reservationRepairFixture() {
  const f = reviewFailureRepairFixture();
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  const deployment = () => ({ ...f.deployment(), profileDigest: managedDigest(f.p) });
  const previous = reserveManagedBudget(active, deployment(), f.p, f.now).state;
  const p = { ...f.p, goEvidenceDigest: digest(801) }, old = previous.plans[2];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment,
    scope: "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1", forward: 12,
    ownerApprovalDigest: digest(802), repairEpochDigest: digest(803),
    priorPlanDigest: managedDigest(old), priorProfileDigest: managedDigest(f.p), profileDigest: managedDigest(p),
    executionEarmark: { ...f.adjustment.executionEarmark,
      reservationRepairProductionAiYen: 1238, reservationRepairImageRetentionYen: 1115 } });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_RESERVATION_REPAIR_V1") throw Error("reservation repair required");
  const input = { ...f.input, baseYen: old.baseYen + 2353, evidenceDigest: digest(804), standardMonthAdjustment: adjustment };
  return { f, previous, p, adjustment, input, now: f.now, deployment };
}
it("preserves all earlier holds and admits only the twelfth bounded deployment", () => {
  const f = reservationRepairFixture(), before = structuredClone(f.previous);
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.plans.slice(0, 2)).toEqual(before.plans.slice(0, 2));
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(active.plans[2].pools).toEqual(before.plans[2].pools);
  expect(active.plans[2].baseYen - before.plans[2].baseYen).toBe(2353);
  expect(managedBudgetForecast(active, "2026-11") - managedBudgetForecast(before, "2026-11")).toBe(2353);
  const deploy = () => ({ ...f.deployment(), profileDigest: managedDigest(f.p) });
  const twelfth = reserveManagedBudget(active, deploy(), f.p, f.now).state;
  expect(() => reserveManagedBudget(twelfth, deploy(), f.p, f.now)).toThrow();
  const stopped = setManagedMonthPlan(twelfth, { ...f.input, standardMonthAdjustment: { ...f.adjustment,
    forward: 11, priorPlanDigest: managedDigest(twelfth.plans[2]), priorProfileDigest: managedDigest(f.p) } }, f.now);
  expect(stopped.operations).toEqual(twelfth.operations);
  expect(stopped.plans[2].baseYen).toBe(active.plans[2].baseYen);
  expect(() => checkManagedStandardBudget(stopped, f.p, f.now)).toThrow();
});
it("rejects stale reservation-repair bindings, reused authority, changed history and deadline extension", () => {
  const f = reservationRepairFixture();
  for (const change of [
    { priorPlanDigest: digest(999) }, { priorProfileDigest: digest(999) },
    { ownerApprovalDigest: f.f.adjustment.ownerApprovalDigest }, { repairEpochDigest: f.f.adjustment.repairEpochDigest },
    { validUntil: "2026-11-08T00:00:00Z" },
    { executionEarmark: { ...f.adjustment.executionEarmark, forecastBaseYen: f.adjustment.executionEarmark.forecastBaseYen - 1 } },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, standardMonthAdjustment: { ...f.adjustment, ...change } }, f.now)).toThrow();
  for (const change of [
    { baseYen: f.input.baseYen - 1 }, { baseYen: f.input.baseYen + 1 },
    { pools: { ...f.input.pools, remaining: f.input.pools.remaining + 1 } },
    { pools: { ...f.input.pools, recovery: f.input.pools.recovery - 1 } },
    { releaseTailYen: f.input.releaseTailYen - 1 }, { completionAllowance: f.f.f.f.allowance },
    { releaseMonthlyCapYen: 40000 }, { reviewedOperationIds: [f.previous.operations[0].operationId] },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, ...change }, f.now)).toThrow();
});
it("keeps the reservation hold on stopped activation and refuses double addition or downgrade", () => {
  const f = reservationRepairFixture(), planned = setManagedMonthPlan(f.previous, f.input, f.now);
  const linked = { ...f.input, standardMonthAdjustment: { ...f.adjustment, priorPlanDigest: managedDigest(planned.plans[2]) } };
  const stopped = setManagedMonthPlan(planned, { ...linked, standardMonthAdjustment: {
    ...linked.standardMonthAdjustment, profileDigest: managedDigest(f.f.p), forward: 11 } }, f.now);
  expect(stopped.plans[2].baseYen).toBe(planned.plans[2].baseYen);
  expect(stopped.operations).toEqual(planned.operations);
  checkManagedStandardBudget(stopped, f.f.p, f.now);
  for (const change of [
    { baseYen: f.input.baseYen + 2353 }, { baseYen: f.input.baseYen - 2353 },
    { standardMonthAdjustment: undefined }, { standardMonthAdjustment: f.f.adjustment },
    ...[{ validUntil: "2026-11-08T00:00:00Z" }, { ownerApprovalDigest: digest(900) }, { repairEpochDigest: digest(901) },
      { priorProfileDigest: managedDigest(f.p) }].map(p => ({ standardMonthAdjustment: { ...linked.standardMonthAdjustment, ...p } })),
  ]) expect(() => setManagedMonthPlan(planned, { ...linked, ...change }, f.now)).toThrow();
});
it("bounds reservation-repair units and all holds and requires a live profile within the original expiry", () => {
  const f = reservationRepairFixture();
  for (const change of [
    { monthlyCapYen: 70001 }, { monthlyCapYen: 69999 }, { forward: 13 }, { forward: 10 }, { jobs: 26 }, { minutes: 3001 },
    { month: "2026-12" }, { validUntil: "2026-12-01T00:00:00Z" }, { priorProfileDigest: undefined },
    ...["productionAiYen","imageRetentionYen","additionalProductionAiYen","additionalImageRetentionYen",
      "reservationRepairProductionAiYen","reservationRepairImageRetentionYen"].map(key => ({
      executionEarmark: { ...f.adjustment.executionEarmark, [key]: 0 } })),
  ]) expect(() => managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment, ...change })).toThrow();
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  checkManagedExecutionBudget(active, f.p, f.now);
  for (const p of [null, undefined, f.f.p]) expect(() => checkManagedExecutionBudget(active, p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(active, f.p, clock("2026-11-06T22:00:00Z"))).toThrow();
  expect(() => checkManagedStandardBudget(active, f.p, clock("2026-11-07T00:00:00Z", 1))).toThrow();
});
function storageHistoryFixture(applied: boolean) {
  const f = reservationRepairFixture();
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  const previous = applied ? reserveManagedBudget(active, {
    ...f.deployment(), profileDigest: managedDigest(f.p), reservationYen: 140,
  }, f.p, f.now).state : active;
  const p = { ...f.p, goEvidenceDigest: digest(901) }, old = previous.plans[2];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment,
    scope: "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1", forward: 13,
    ownerApprovalDigest: digest(902), repairEpochDigest: digest(903),
    priorPlanDigest: managedDigest(old), priorProfileDigest: managedDigest(f.p), profileDigest: managedDigest(p) });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_STORAGE_HISTORY_REPAIR_V1") throw Error("storage history required");
  const input = { ...f.input, baseYen: old.baseYen, evidenceDigest: digest(904), standardMonthAdjustment: adjustment };
  return { f, previous, p, adjustment, input, now: f.now };
}
it.each([false, true])("carries the unchanged reservation plan and holds across storage-history CAS=%s", applied => {
  const f = storageHistoryFixture(applied), before = structuredClone(f.previous);
  const planned = setManagedMonthPlan(before, f.input, f.now);
  const active = activate(planned, f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.administration).toEqual(before.administration);
  expect(active.plans.slice(0, 2)).toEqual(before.plans.slice(0, 2));
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(active.plans[2].baseYen).toBe(before.plans[2].baseYen);
  expect(active.plans[2].pools).toEqual(before.plans[2].pools);
  expect(f.adjustment.executionEarmark).toEqual(f.f.adjustment.executionEarmark);
  expect(managedBudgetForecast(active, "2026-11")).toBe(managedBudgetForecast(before, "2026-11"));
  const deploy = () => ({ ...f.f.deployment(), profileDigest: managedDigest(f.p) });
  let full = reserveManagedBudget(active, deploy(), f.p, f.now).state;
  if (!applied) full = reserveManagedBudget(full, deploy(), f.p, f.now).state;
  expect(() => reserveManagedBudget(full, deploy(), f.p, f.now)).toThrow();
  const stopped = setManagedMonthPlan(full, { ...f.input, standardMonthAdjustment: { ...f.adjustment,
    forward: 12, priorPlanDigest: managedDigest(full.plans[2]), priorProfileDigest: managedDigest(f.p) } }, f.now);
  expect(stopped.operations).toEqual(full.operations);
  expect(() => checkManagedStandardBudget(stopped, f.p, f.now)).toThrow();
});
it("rejects stale storage-history bindings, extended expiry, changed financials and extra earmarks", () => {
  const f = storageHistoryFixture(true);
  for (const change of [
    { priorPlanDigest: digest(999) }, { priorProfileDigest: digest(999) },
    { ownerApprovalDigest: f.f.adjustment.ownerApprovalDigest }, { repairEpochDigest: f.f.adjustment.repairEpochDigest },
    { validUntil: "2026-11-08T00:00:00Z" },
    { executionEarmark: { ...f.adjustment.executionEarmark, forecastBaseYen: f.adjustment.executionEarmark.forecastBaseYen + 1 } },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, standardMonthAdjustment: { ...f.adjustment, ...change } }, f.now)).toThrow();
  for (const change of [
    { baseYen: f.input.baseYen + 2353 }, { baseYen: f.input.baseYen - 1 },
    { pools: { ...f.input.pools, remaining: f.input.pools.remaining + 1 } },
    { releaseTailYen: f.input.releaseTailYen - 1 }, { releaseMonthlyCapYen: 70000 },
    { reviewedOperationIds: [f.previous.operations[0].operationId] }, { completionAllowance: f.f.f.f.f.allowance },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, ...change }, f.now)).toThrow();
  for (const change of [{ forward: 14 }, { forward: 11 }, { monthlyCapYen: 70001 }, { jobs: 26 },
    { executionEarmark: { ...f.adjustment.executionEarmark, storageHistoryProductionAiYen: 1238 } }]) {
    expect(() => managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment, ...change })).toThrow();
  }
});
it.each([false, true])("records stop12 but rejects admission even with consumption within twelve CAS=%s", applied => {
  const f = storageHistoryFixture(applied);
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  const stopped = setManagedMonthPlan(active, { ...f.input, standardMonthAdjustment: { ...f.adjustment,
    forward: 12, priorPlanDigest: managedDigest(active.plans[2]), priorProfileDigest: managedDigest(f.p) } }, f.now);
  expect(stopped.operations).toEqual(active.operations);
  expect(stopped.plans[2].baseYen).toBe(active.plans[2].baseYen);
  expect(stopped.plans[2].standardMonthAdjustment?.forward).toBe(12);
  expect(() => checkManagedStandardBudget(stopped, f.p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(stopped, f.p, f.now)).toThrow();
  expect(() => activate(stopped, f.p, f.now)).toThrow();
  expect(() => reserveManagedBudget(stopped, { ...f.f.deployment(), profileDigest: managedDigest(f.p),
    units: emptyManagedBudgetUnits() }, f.p, f.now)).toThrow();
});
it("pins the storage-history epoch and prevents scope removal, re-addition or profile-less expiry bypass", () => {
  const f = storageHistoryFixture(false), planned = setManagedMonthPlan(f.previous, f.input, f.now);
  const linked = { ...f.input, standardMonthAdjustment: { ...f.adjustment, priorPlanDigest: managedDigest(planned.plans[2]) } };
  for (const change of [undefined, f.f.adjustment,
    ...[{ ownerApprovalDigest: digest(999) }, { repairEpochDigest: digest(999) }, { validUntil: "2026-11-08T00:00:00Z" }]
      .map(change => ({ ...linked.standardMonthAdjustment, ...change }))]) {
    expect(() => setManagedMonthPlan(planned, { ...linked, standardMonthAdjustment: change }, f.now)).toThrow();
  }
  const active = activate(planned, f.p, f.now);
  checkManagedExecutionBudget(active, f.p, f.now);
  for (const p of [null, undefined, f.f.p]) expect(() => checkManagedExecutionBudget(active, p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(active, f.p, clock("2026-11-07T00:00:00Z"))).toThrow();
  expect(() => setManagedMonthPlan(planned, { ...linked, baseYen: linked.baseYen + 2353 }, f.now)).toThrow();
});
function bindingRepairFixture() {
  const f = storageHistoryFixture(true), previous = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  const p = { ...f.p, goEvidenceDigest: digest(920) }, old = previous.plans[2];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment,
    scope: "ISSUE150_NOVEMBER_BINDING_REPAIR_V1", ownerApprovalDigest: digest(921), repairEpochDigest: digest(922),
    priorPlanDigest: managedDigest(old), priorProfileDigest: managedDigest(f.p), profileDigest: managedDigest(p),
    executionEarmark: { ...f.adjustment.executionEarmark, bindingRepairProductionAiYen: 1238, bindingRepairImageRetentionYen: 1115 } });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_BINDING_REPAIR_V1") throw Error("binding repair required");
  const input = { ...f.input, baseYen: old.baseYen + 2353, pools: { ...old.pools, remaining: old.pools.remaining + 389 },
    standardMonthAdjustment: adjustment };
  return { f, previous, p, adjustment, input, now: f.now };
}
it("adds one binding-repair hold and release-pool shortfall without refunding history", () => {
  const f = bindingRepairFixture(), before = structuredClone(f.previous);
  const active = activate(setManagedMonthPlan(before, f.input, f.now), f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.administration).toEqual(before.administration);
  expect(active.plans.slice(0, 2)).toEqual(before.plans.slice(0, 2));
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(managedBudgetForecast(active, "2026-11")).toBe(managedBudgetForecast(before, "2026-11") + 2353 + 389);
  checkManagedExecutionBudget(active, f.p, f.now);
  const full = reserveManagedBudget(active, { ...f.f.f.deployment(), profileDigest: managedDigest(f.p) }, f.p, f.now).state;
  expect(() => reserveManagedBudget(full, { ...f.f.f.deployment(), profileDigest: managedDigest(f.p) }, f.p, f.now)).toThrow();
});
it("rejects stale binding-repair authority, extra funding and changes to prior holds", () => {
  const f = bindingRepairFixture();
  for (const change of [
    { priorPlanDigest: digest(999) }, { priorProfileDigest: digest(999) },
    { ownerApprovalDigest: f.f.adjustment.ownerApprovalDigest }, { repairEpochDigest: f.f.adjustment.repairEpochDigest },
    { validUntil: "2026-11-08T00:00:00Z" },
    { executionEarmark: { ...f.adjustment.executionEarmark, forecastBaseYen: f.adjustment.executionEarmark.forecastBaseYen + 1 } },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, standardMonthAdjustment: { ...f.adjustment, ...change } }, f.now)).toThrow();
  for (const change of [
    { baseYen: f.input.baseYen - 1 }, { baseYen: f.input.baseYen + 1 },
    ...["remaining", "storage", "recovery"].map(pool => ({ pools: { ...f.input.pools, [pool]: f.input.pools[pool as keyof typeof f.input.pools] + 1 } })),
    { releaseTailYen: f.input.releaseTailYen - 1 }, { releaseMonthlyCapYen: 70000 },
    { reviewedOperationIds: [f.previous.operations[0].operationId] },
  ]) expect(() => setManagedMonthPlan(f.previous, { ...f.input, ...change }, f.now)).toThrow();
  for (const change of [{ forward: 14 }, { forward: 11 }, { monthlyCapYen: 70001 }, { jobs: 26 },
    { executionEarmark: { ...f.adjustment.executionEarmark, bindingRepairProductionAiYen: 0 } },
    { executionEarmark: { ...f.adjustment.executionEarmark, bindingRepairImageRetentionYen: 0 } }]) {
    expect(() => managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment, ...change })).toThrow();
  }
});
it("keeps the binding-repair funding fixed on profile transition and stops at twelve", () => {
  const f = bindingRepairFixture(), planned = setManagedMonthPlan(f.previous, f.input, f.now);
  const active = activate(planned, f.p, f.now), linked = { ...f.input, standardMonthAdjustment: { ...f.adjustment,
    priorPlanDigest: managedDigest(active.plans[2]), priorProfileDigest: managedDigest(f.p) } };
  const retained = setManagedMonthPlan(active, linked, f.now);
  expect(retained.plans[2].baseYen).toBe(active.plans[2].baseYen);
  expect(retained.plans[2].pools).toEqual(active.plans[2].pools);
  for (const change of [undefined, f.f.adjustment,
    ...[{ ownerApprovalDigest: digest(999) }, { repairEpochDigest: digest(999) }, { validUntil: "2026-11-08T00:00:00Z" }]
      .map(change => ({ ...linked.standardMonthAdjustment, ...change }))]) {
    expect(() => setManagedMonthPlan(active, { ...linked, standardMonthAdjustment: change }, f.now)).toThrow();
  }
  expect(() => setManagedMonthPlan(active, { ...linked, baseYen: linked.baseYen + 2353 }, f.now)).toThrow();
  for (const p of [null, undefined, f.f.p]) expect(() => checkManagedExecutionBudget(active, p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(active, f.p, clock("2026-11-07T00:00:00Z"))).toThrow();
  const stopped = setManagedMonthPlan(active, { ...linked, standardMonthAdjustment: { ...linked.standardMonthAdjustment, forward: 12 } }, f.now);
  expect(stopped.operations).toEqual(active.operations);
  expect(() => checkManagedExecutionBudget(stopped, f.p, f.now)).toThrow();
  expect(() => activate(stopped, f.p, f.now)).toThrow();
  expect(() => reserveManagedBudget(stopped, { ...f.f.f.deployment(), profileDigest: managedDigest(f.p),
    units: emptyManagedBudgetUnits() }, f.p, f.now)).toThrow();
});
it("activates a new ordinary profile without retargeting an old completion signature", () => {
  const f = completionFixture(), p = { ...f.p, goEvidenceDigest: digest(410) }, before = structuredClone(f.allowed);
  expect(() => activate(f.allowed, p, f.now)).toThrow();
  const s = setManagedMonthPlan(f.allowed, { ...f.input, standardMonthAdjustment: standardAdjustment(p) }, f.now);
  const activated = activate(s, p, f.now);
  checkManagedStandardBudget(activated, p, f.now);
  expect(activated.plans[1].completionAllowance).toEqual(f.allowance);
  expect(activated.operations).toEqual(before.operations);
  expect(activated.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(() => checkManagedCompletionBudget(activated, f.allowance, f.now)).toThrow();
  const limit = structuredClone(activated); limit.plans[1].baseYen += 38331 - managedBudgetForecast(limit, "2026-10");
  checkManagedStandardBudget(limit, p, f.now);
  limit.plans[1].baseYen++;
  expect(() => checkManagedStandardBudget(limit, p, f.now)).toThrow();
  const november = clock("2026-11-01T00:00:00Z");
  expect(() => setManagedMonthPlan(activated, { ...f.input, completionAllowance: undefined, standardMonthAdjustment: standardAdjustment(p) }, november)).toThrow();
  const restored = setManagedMonthPlan(activated, { ...f.input, completionAllowance: undefined }, november);
  expect(restored.plans[1]).toEqual(activated.plans[1]);
  expect(restored.plans[2].standardMonthAdjustment).toBeUndefined();
  expect(restored.operations).toEqual(activated.operations);
  expect(() => checkManagedStandardBudget(restored, p, november)).toThrow();
});
it("rechecks all nine ordinary execution limits without inheriting another profile's completion expiry", () => {
  const f = completionFixture(), p = { ...f.p, goEvidenceDigest: digest(411) };
  const s = activate(setManagedMonthPlan(f.allowed, { ...f.input,
    completionAllowance: { ...f.allowance, validUntil: "2026-10-01T01:00:00Z" },
    standardMonthAdjustment: standardAdjustment(p) }, f.now), p, f.now);
  expect(checkManagedExecutionBudget(s, p, f.now)).toBeUndefined();
  expect(() => checkManagedExecutionBudget(s, f.p, f.now)).toThrow();
  expect(() => checkManagedExecutionBudget(s, null, f.now)).toThrow();
  const r = { ...f.r, profileDigest: managedDigest(p), kind: "watch", units: emptyManagedBudgetUnits() };
  const reserved = reserveManagedBudget(s, r, p, f.now).state;
  const limits = { ...p.monthlyUnits, jobs: 25, minutes: 3000, forward: 9 };
  for (const unit of Object.keys(limits) as Array<keyof typeof limits>) {
    const over = structuredClone(reserved);
    over.operations[1].knownUnits[unit] = limits[unit] + 1;
    expect(() => checkManagedExecutionBudget(over, p, f.now)).toThrow();
  }
  const overCost = structuredClone(reserved); overCost.plans[1].baseYen = 38331;
  expect(() => checkManagedExecutionBudget(overCost, p, f.now)).toThrow();
  const missing = structuredClone(reserved); delete missing.plans[1].standardMonthAdjustment;
  expect(() => checkManagedExecutionBudget(missing, p, f.now)).toThrow();
});
it("uses the signed completion allowance for the whole history while retaining ordinary profiles and old plans", () => {
  const f = completionFixture(), before = structuredClone(f.allowed);
  const first = reserveManagedBudget(f.allowed, f.r, f.p, f.now).state;
  expect(managedBudgetForecast(first, "2026-10")).toBe(31_200);
  expect(first.operations[0]).toEqual(f.september.operations[0]);
  expect(first.plans[0]).toEqual(f.september.plans[0]);
  expect(first.legacyUnknownYen).toBe(f.september.legacyUnknownYen);
  expect(first.releaseTailYen).toBe(f.allowed.releaseTailYen);
  expect(f.p.monthlyCapYen).toBe(30_000);
  const second = reserveManagedBudget(first, { ...f.r, operationId: randomUUID(), requestDigest: managedDigest(randomUUID()) }, f.p, f.now).state;
  expect(() => reserveManagedBudget(second, { ...f.r, operationId: randomUUID(), requestDigest: managedDigest(randomUUID()) }, f.p, f.now)).toThrow();
  expect(claimManagedBudgetPhase(first, f.r.operationId, "stage", f.p, f.now).operations[1].stage).toBe("claimed");
  expect(f.allowed).toEqual(before);
});
it.each(["missing", "wrong-profile", "expiry", "scope", "month", "over-cost", "review-required"])(
  "refuses invalid completion %s and does not erase prior reservations", reason => {
    const f = completionFixture();
    if (reason === "missing") delete f.allowed.plans[1].completionAllowance;
    if (reason === "wrong-profile") f.allowed.plans[1].completionAllowance!.profileDigest = digest(999);
    if (reason === "expiry") f.allowed.plans[1].completionAllowance!.validUntil = "2026-10-01T01:00:00.000Z";
    if (reason === "scope") Object.assign(f.allowed.plans[1].completionAllowance!, { scope: "OTHER" });
    if (reason === "month") Object.assign(f.allowed.plans[1].completionAllowance!, { month: "2026-11" });
    if (reason === "over-cost") f.allowed.legacyUnknownYen += 1000;
    if (reason === "review-required") f.allowed.operations[0].reviewRequired = true;
    const before = structuredClone(f.allowed);
    expect(() => reserveManagedBudget(f.allowed, f.r, f.p, f.now)).toThrow();
    expect(f.allowed).toEqual(before);
  });
it("rejects an allowance copied to November and returns to the normal cap without dropping history", () => {
  const f = completionFixture(), november = clock("2026-11-01T00:00:00.000Z");
  expect(() => setManagedMonthPlan(f.allowed, f.input, november)).toThrow();
  const input = { ...f.input, completionAllowance: undefined };
  const restored = setManagedMonthPlan(f.allowed, input, november);
  expect(restored.operations).toEqual(f.allowed.operations);
  expect(restored.plans[1]).toEqual(f.allowed.plans[1]);
  expect(restored.plans[2].completionAllowance).toBeUndefined();
  expect(() => reserveManagedBudget(restored, f.r, f.p, november)).toThrow();
  const normal = setManagedMonthPlan(restored, { ...input, baseYen: 10_000 }, november);
  const noJobs = { ...f.r, kind: "validation", units: emptyManagedBudgetUnits() };
  expect(reserveManagedBudget(normal, noJobs, f.p, november).created).toBe(true);
  expect(() => checkManagedCompletionBudget(normal, f.allowance, november)).toThrow();
});
it("limits a signed bootstrap step cumulatively without adding a new plan field", () => {
  const f = completionFixture();
  const r = { ...f.r, kind: "deploy", units: { ...emptyManagedBudgetUnits(), forward: 1 } };
  const reserved = reserveManagedBudget(f.s, r, f.p, f.now).state;
  checkManagedCompletionBudget(reserved, f.allowance, f.now);
  expect(reserved.operations[0]).toEqual(f.september.operations[0]);
  expect(reserved.operations[1].scope).toBe("standard");
  expect(reserved.plans.every(p => p.completionAllowance === undefined)).toBe(true);
  expect(() => checkManagedCompletionBudget(reserved, { ...f.allowance,
    cumulativeUnits: { ...f.allowance.cumulativeUnits, forward: 8 } }, f.now)).toThrow();
});
it("confines the reviewed release allowance to its month without changing Standard or historical plans", () => {
  const original = state(), serialized = JSON.stringify(original);
  expect(JSON.stringify(managedBudgetStateSchema.parse(original))).toBe(serialized);
  const input = { baseYen: 19_000, pools: original.plans[0].pools, pricingDigest: digest(4),
    evidenceDigest: digest(91), releaseTailYen: original.releaseTailYen };
  const without = setManagedMonthPlan(original, input, clock());
  expect(managedBudgetForecast(without, "2026-09")).toBe(31_000);
  expect(() => reserveManagedBudget(without, request(), null, clock())).toThrow();
  const allowed = setManagedMonthPlan(original, { ...input, releaseMonthlyCapYen: 31_000 }, clock());
  const r = request(), reserved = reserveManagedBudget(allowed, r, null, clock()).state;
  expect(claimManagedBudgetPhase(reserved, r.operationId, "stage", null, clock()).operations[0].stage).toBe("claimed");
  expect(() => reserveManagedBudget({ ...allowed, legacyUnknownYen: 2001 }, request(), null, clock())).toThrow();
  expect(() => activate(allowed, profile())).toThrow();
  expect(() => reserveManagedBudget(without, request({ releaseMonthlyCapYen: 31_000 }), null, clock())).toThrow();
  expect(() => setManagedMonthPlan(original, { ...input, releaseMonthlyCapYen: 31_000 }, clock("2026-09-30T15:00:01.000Z"))).toThrow();
  expect(() => reserveManagedBudget(setManagedMonthPlan(original, input, clock("2026-09-30T15:00:01.000Z")), request(), null,
    clock("2026-09-30T15:00:01.000Z"))).toThrow();
  expect(() => reserveManagedBudget({ ...allowed, releaseTailYen: 50_001 }, request(), null, clock())).toThrow();
  expect(() => reserveManagedBudget(allowed, request({ units: { ...emptyManagedBudgetUnits(), jobs: 25 } }), null, clock())).toThrow();
  expect(original).toEqual(JSON.parse(serialized));
});
it("allocates one import reservation across stage/start without adding it to its pool again", () => {
  const original = state(), r = request(); const reserved = reserveManagedBudget(original, r, null, clock()).state;
  expect(original.operations).toHaveLength(0); expect(managedBudgetForecast(reserved, "2026-09")).toBe(22_000);
  expect(reserved.releaseTailYen).toBe(19_000);
  const stage = claimManagedBudgetPhase(reserved, r.operationId, "stage", null, clock());
  const staged = confirmManagedBudgetStage(stage, r.operationId, r.requestDigest, digest(5), clock());
  const started = claimManagedBudgetPhase(staged, r.operationId, "start", null, clock());
  expect(started.operations).toHaveLength(1); expect(started.operations[0].units.jobs).toBe(1);
  expect(managedBudgetForecast(started, "2026-09")).toBe(22_000);
  expect(() => claimManagedBudgetPhase(started, r.operationId, "start", null, clock())).toThrow();
});
it("retains a claimed phase after ACK loss; a read-back does not authorize another stage", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const persisted = claimManagedBudgetPhase(reserved, r.operationId, "stage", null, clock());
  expect(reserveManagedBudget(persisted, r, null, clock()).created).toBe(false);
  expect(() => claimManagedBudgetPhase(persisted, r.operationId, "stage", null, clock())).toThrow();
  expect(() => claimManagedBudgetPhase(persisted, r.operationId, "start", null, clock())).toThrow();
});
it("rejects pool exhaustion, missing release tail and request/operation substitution", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  expect(() => reserveManagedBudget(reserved, request({ reservationYen: 7001 }), null, clock())).toThrow();
  expect(() => reserveManagedBudget({ ...state(), releaseTailYen: 999 }, r, null, clock())).toThrow();
  expect(() => reserveManagedBudget(reserved, { ...r, operationId: randomUUID() }, null, clock())).toThrow();
  expect(() => reserveManagedBudget(reserved, { ...r, kind: "watch" }, null, clock())).toThrow();
  expect(() => reserveManagedBudget(reserved, { ...r, processingMonth: "2026-10" }, null, clock())).toThrow();
});
it("keeps the same unknown operation once in every future month without returning its release reservation", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const unknown = markManagedBudgetUnknown(reserved, r.operationId, clock());
  const october = nextMonth(unknown), november = nextMonth(october, "2026-10-31T15:00:01.000Z");
  expect(managedBudgetForecast(october, "2026-10")).toBe(23_000);
  expect(managedBudgetForecast(november, "2026-11")).toBe(23_000);
  expect(november.releaseTailYen).toBe(19_000);
  expect(() => claimManagedBudgetPhase(october, r.operationId, "stage", null, clock("2026-09-30T15:00:01.000Z"))).toThrow();
});
it("rejects new or late-starting work that cannot fit before JST month end or reservation expiry", () => {
  expect(() => reserveManagedBudget(state(), request(), null, clock("2026-09-30T14:59:00.000Z"))).toThrow();
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock("2026-09-30T10:00:00.000Z")).state;
  expect(() => claimManagedBudgetPhase(reserved, r.operationId, "stage", null, clock("2026-09-30T14:00:00.000Z"))).toThrow();
  const earlier = reserveManagedBudget(state(), request(), null, clock()).state;
  expect(() => claimManagedBudgetPhase(earlier, earlier.operations[0].operationId, "stage", null, clock("2026-09-23T05:00:00.000Z"))).toThrow();
});
it("does not return unknown fees on partial usage; final evidence settles exactly once", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const partial = settleManagedBudget(reserved, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(20), knownUnits: { normal: 0 } }, clock());
  expect(partial.releaseTailYen).toBe(19_000); expect(partial.operations[0].actualYen).toBeNull();
  const proof = { operationId: r.operationId, requestDigest: r.requestDigest, evidenceDigest: digest(21),
    knownUnits: { ...r.units, minutes: 1 }, actualYen: 100 };
  const settled = settleManagedBudget(partial, proof, clock());
  expect(settled.releaseTailYen).toBe(19_900);
  expect(settleManagedBudget(settled, proof, clock("2026-09-23T00:01:00.000Z"))).toEqual(settled);
  expect(managedBudgetForecast(nextMonth(settled), "2026-10")).toBe(22_000);
  expect(settled.operations[0].reservationYen).toBe(1000);
});
it("persists an observed overrun, retains future work funds, and stops new starts until reviewed", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const observed = settleManagedBudget(reserved, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(30), knownUnits: {}, observedYen: 1200 }, clock());
  expect(observed.operations[0]).toMatchObject({ observedYen: 1200, actualYen: null, reviewRequired: true });
  expect(() => reserveManagedBudget(observed, request(), null, clock())).toThrow();
  const final = settleManagedBudget(observed, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(31), knownUnits: r.units, actualYen: 1200 }, clock());
  expect(final.releaseTailYen).toBe(19_000); expect(final.operations[0].actualYen).toBe(1200);
  const reviewed = setManagedMonthPlan(final, { baseYen: 10_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 },
    pricingDigest: digest(4), releaseTailYen: final.releaseTailYen, evidenceDigest: digest(32), reviewedOperationIds: [r.operationId] }, clock());
  expect(reserveManagedBudget(reviewed, request(), null, clock()).created).toBe(true);
});
it("records late actual increases and over-cap quantities without turning them into another start allowance", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const first = settleManagedBudget(reserved, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(40), knownUnits: r.units, actualYen: 100 }, clock());
  const late = settleManagedBudget(first, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(41), knownUnits: { jobs: 25 }, actualYen: 50_001 }, clock());
  expect(late.operations[0]).toMatchObject({ actualYen: 50_001, knownUnits: { jobs: 25 }, reviewRequired: true });
  expect(late.releaseTailYen).toBe(19_900);
  expect(() => reserveManagedBudget(late, request(), null, clock())).toThrow();
});
it("rejects inactive profiles and keeps the shared pool after an independently verified profile revision", () => {
  const p = profile(), r = request({ scope: "standard", profileDigest: managedDigest(p), reservationYen: 4000 });
  expect(() => reserveManagedBudget(state(), r, p, clock())).toThrow();
  const reserved = reserveManagedBudget(activate(state(), p), r, p, clock()).state;
  const revised = { ...p, measurementDigest: digest(51) }, changed = activate(reserved, revised);
  expect(() => reserveManagedBudget(changed, request({ scope: "standard", profileDigest: managedDigest(revised), reservationYen: 4001 }), revised, clock())).toThrow();
  expect(() => claimManagedBudgetPhase(changed, r.operationId, "stage", revised, clock())).toThrow();
  expect(managedBudgetForecast(changed, "2026-09")).toBe(22_000);
});
it("keeps release totals across months while standard operations use the measured monthly profile", () => {
  const r = request({ units: { ...emptyManagedBudgetUnits(), normal: 900 } });
  const reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const settled = settleManagedBudget(reserved, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(60), knownUnits: r.units, actualYen: 100 }, clock());
  const october = nextMonth(settled), now = clock("2026-09-30T15:00:01.000Z");
  expect(() => reserveManagedBudget(october, request({ units: { ...emptyManagedBudgetUnits(), normal: 1 } }), null, now)).toThrow();
  const p = profile(), active = activate(october, p, now);
  const standard = request({ scope: "standard", profileDigest: managedDigest(p), units: { ...emptyManagedBudgetUnits(), normal: 1 } });
  expect(reserveManagedBudget(active, standard, p, now).created).toBe(true);
});
it("records an over-cap plan for reconciliation but never treats it as permission", () => {
  const over = setManagedMonthPlan(state(), { baseYen: 40_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 },
    pricingDigest: digest(4), releaseTailYen: 20_000, evidenceDigest: digest(70) }, clock());
  expect(managedBudgetForecast(over, "2026-09")).toBe(52_000);
  expect(() => reserveManagedBudget(over, request(), null, clock())).toThrow();
  expect(() => reserveManagedBudget({ ...state(), serviceKey: "another-wallet" }, request(), null, clock())).toThrow();
});
it("retains five release fixtures and their unknown costs while admitting five standard cases", () => {
  const r = request({ cases: [1, 2, 3, 4, 5] });
  const release = markManagedBudgetUnknown(reserveManagedBudget(state(), r, null, clock()).state, r.operationId, clock());
  const p = { ...profile(), cases: [6, 7, 8, 9, 10] }, activated = activate(release, p);
  expect(activated.operations).toEqual(release.operations);
  expect(activated.releaseTailYen).toBe(release.releaseTailYen);
  expect(activated.legacyUnknownYen).toBe(release.legacyUnknownYen);
  expect(activated.plans).toEqual(release.plans);
  expect(managedBudgetForecast(activated, "2026-09")).toBe(managedBudgetForecast(release, "2026-09"));
  const standard = request({ scope: "standard", profileDigest: managedDigest(p), cases: p.cases });
  const reserved = reserveManagedBudget(activated, standard, p, clock()).state;
  expect(reserved.cases).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(reserved.operations[0]).toEqual(release.operations[0]);
  expect(reserved.releaseTailYen).toBe(release.releaseTailYen);
  expect(() => reserveManagedBudget(reserved, request({ cases: [6] }), null, clock())).toThrow();
  expect(() => reserveManagedBudget(reserved, request({ ...standard, operationId: randomUUID(), requestDigest: managedDigest(randomUUID()), cases: [1] }), p, clock())).toThrow();
  expect(() => activate(reserved, { ...p, cases: [6, 7, 8, 9, 10, 11] })).toThrow();
  const revised = { ...p, cases: [11, 12, 13, 14, 15], measurementDigest: digest(52) }, changed = activate(reserved, revised);
  expect(changed.cases).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  expect(changed.operations).toEqual(reserved.operations);
  expect(() => reserveManagedBudget(changed, request({ scope: "standard", profileDigest: managedDigest(revised), cases: p.cases }), revised, clock())).toThrow();
  expect(reserveManagedBudget(changed, request({ scope: "standard", profileDigest: managedDigest(revised), cases: revised.cases }), revised, clock()).created).toBe(true);
  expect(() => validateManagedBudgetState({ ...reserved, cases: reserved.cases.slice(1) }, digest(1))).toThrow();
  expect(() => validateManagedBudgetState({ ...reserved, cases: Array.from({ length: 10_001 }, (_, i) => i + 1) }, digest(1))).toThrow();
});
it.each(["watch", "delivery", "backup", "recovery"])("retains the release case cap after %s settlement, month change and profile activation", kind => {
  const r = request({ kind, cases: [1, 2, 3, 4, 5] }), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const settled = settleManagedBudget(reserved, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(61), knownUnits: r.units, actualYen: 100 }, clock());
  const now = clock("2026-09-30T15:00:01.000Z"), p = { ...profile(), cases: [6, 7, 8, 9, 10] };
  const changed = activate(nextMonth(settled), p, now);
  expect(() => reserveManagedBudget(changed, request({ cases: [6] }), null, now)).toThrow();
  expect(reserveManagedBudget(changed, request({ cases: [5] }), null, now).created).toBe(true);
  expect(() => reserveManagedBudget(changed, request({ cases: [1, 2, 3, 4, 5, 6] }), null, now)).toThrow();
});
it("carries a later unsettled bill after a prior final bill, even after an administrative review", () => {
  const r = request(), reserved = reserveManagedBudget(state(), r, null, clock()).state;
  const firstProof = { operationId: r.operationId, requestDigest: r.requestDigest, evidenceDigest: digest(80), knownUnits: r.units, actualYen: 100 };
  const first = settleManagedBudget(reserved, firstProof, clock());
  const observed = settleManagedBudget(first, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(81), knownUnits: {}, observedYen: 1200 }, clock());
  expect(observed.operations[0]).toMatchObject({ actualYen: 100, observedYen: 1200, unknown: true, reviewRequired: true });
  const reviewed = setManagedMonthPlan(observed, { baseYen: 10_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 },
    pricingDigest: digest(4), releaseTailYen: observed.releaseTailYen, evidenceDigest: digest(82), reviewedOperationIds: [r.operationId] }, clock());
  expect(managedBudgetForecast(nextMonth(reviewed), "2026-10")).toBe(23_200);
  const final = settleManagedBudget(reviewed, { operationId: r.operationId, requestDigest: r.requestDigest,
    evidenceDigest: digest(83), knownUnits: r.units, actualYen: 1200 }, clock());
  expect(managedBudgetForecast(nextMonth(final), "2026-10")).toBe(22_000);
  expect(settleManagedBudget(final, firstProof, clock())).toEqual(final);
  expect(() => settleManagedBudget(final, { ...firstProof, actualYen: 1200 }, clock())).toThrow();
});
it("retains the 65th bill and bounded audit fingerprints, then stops further admission", () => {
  const r = request(); let s = reserveManagedBudget(state(), r, null, clock()).state;
  for (let sequence = 1; sequence <= 65; sequence++) s = settleSequence(s, { operationId: r.operationId, requestDigest: r.requestDigest,
    sequence, evidenceDigest: digest(100 + sequence), knownUnits: {}, observedYen: sequence === 65 ? 1200 : sequence }, clock());
  expect(s.operations[0]).toMatchObject({ lastProofSequence: 65, observedYen: 1200, reviewRequired: true, unknown: true });
  expect(s.operations[0].settlements).toHaveLength(64); expect(s.operations[0].evidenceDigests).toHaveLength(64);
  expect(managedBudgetForecast(nextMonth(s), "2026-10")).toBe(23_200);
  expect(() => reserveManagedBudget(s, request(), null, clock())).toThrow();
  const review = { baseYen: 10_000, pools: { remaining: 8000, storage: 1000, recovery: 1000 },
    pricingDigest: digest(4), releaseTailYen: s.releaseTailYen, evidenceDigest: digest(200), reviewedOperationIds: [r.operationId] };
  const reviewed = setManagedMonthPlan(s, review, clock());
  expect(reviewed.operations[0].reviewRequired).toBe(false);
  expect(setManagedMonthPlan(reviewed, review, clock())).toEqual(reviewed);
  expect(() => settleSequence(s, { operationId: r.operationId, requestDigest: r.requestDigest, sequence: 67,
    evidenceDigest: digest(167), knownUnits: {}, observedYen: 1300 }, clock())).toThrow();
});
it("keeps global plan growth out of capacity reserved for final operation evidence", () => {
  const s = state();
  s.plans = Array.from({ length: 112 }, (_, i) => ({ ...s.plans[0], month: `${2030 + Math.floor(i / 12)}-${String(i % 12 + 1).padStart(2, "0")}`,
    evidenceDigests: Array.from({ length: 128 }, (_, n) => digest(n + 1)) }));
  expect(() => validateManagedBudgetState(s, digest(1))).not.toThrow();
  s.plans.push({ ...s.plans[0], month: "2026-09" });
  // Additional plans eventually exhaust only the plan allowance, while the
  // dedicated operation evidence allowance remains available for settlement.
  for (let i = 0; i < 8; i++) s.plans.push({ ...s.plans[0], month: `2050-${String(i + 1).padStart(2, "0")}` });
  expect(() => validateManagedBudgetState(s, digest(1))).toThrow();
});

function reviewScopeRepairFixture() {
  const f = bindingRepairFixture();
  const active = activate(setManagedMonthPlan(f.previous, f.input, f.now), f.p, f.now);
  const deployment = () => ({ ...f.f.f.deployment(), profileDigest: managedDigest(f.p) });
  const previous = reserveManagedBudget(active, deployment(), f.p, f.now).state;
  const p = { ...f.p, goEvidenceDigest: digest(950) }, old = previous.plans[2];
  const adjustment = managedStandardMonthAdjustmentSchema.parse({ ...f.adjustment,
    scope: "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1", forward: 14,
    ownerApprovalDigest: digest(951), repairEpochDigest: digest(952),
    priorPlanDigest: managedDigest(old), priorProfileDigest: managedDigest(f.p), profileDigest: managedDigest(p),
    validUntil: "2026-11-09T00:00:00Z",
    executionEarmark: { ...f.adjustment.executionEarmark, reviewScopeRepairProductionAiYen: 1238, reviewScopeRepairImageRetentionYen: 1115 } });
  if (adjustment.scope !== "ISSUE150_NOVEMBER_REVIEW_SCOPE_REPAIR_V1") throw Error("review scope repair required");
  const input = { ...f.input, baseYen: old.baseYen + 2353, pools: { ...old.pools, remaining: old.pools.remaining + 535 }, standardMonthAdjustment: adjustment };
  return { f, previous, p, adjustment, input, now: f.now, deployment };
}
it("retains prior review failures and funds only one fourteenth deployment", () => {
  const f = reviewScopeRepairFixture(), before = structuredClone(f.previous);
  const active = activate(setManagedMonthPlan(before, f.input, f.now), f.p, f.now);
  expect(active.operations).toEqual(before.operations);
  expect(active.administration).toEqual(before.administration);
  expect(active.plans.slice(0,2)).toEqual(before.plans.slice(0,2));
  expect(active.legacyUnknownYen).toBe(before.legacyUnknownYen);
  expect(active.releaseTailYen).toBe(before.releaseTailYen);
  expect(managedBudgetForecast(active,"2026-11")-managedBudgetForecast(before,"2026-11")).toBe(2888);
  checkManagedExecutionBudget(active,f.p,f.now);
  const full = reserveManagedBudget(active,{ ...f.deployment(), profileDigest: managedDigest(f.p) },f.p,f.now).state;
  expect(() => reserveManagedBudget(full,{ ...f.deployment(),profileDigest:managedDigest(f.p) },f.p,f.now)).toThrow();
});
it("rejects stale review-scope authority, altered holds and any extra pool replenishment", () => {
  const f = reviewScopeRepairFixture();
  for (const change of [{priorPlanDigest:digest(999)},{priorProfileDigest:digest(999)},
    {ownerApprovalDigest:f.f.adjustment.ownerApprovalDigest},{repairEpochDigest:f.f.adjustment.repairEpochDigest},
    {executionEarmark:{...f.adjustment.executionEarmark,forecastBaseYen:f.adjustment.executionEarmark.forecastBaseYen+1}}])
    expect(() => setManagedMonthPlan(f.previous,{...f.input,standardMonthAdjustment:{...f.adjustment,...change}},f.now)).toThrow();
  for (const change of [{baseYen:f.input.baseYen+1},{baseYen:f.input.baseYen-1},
    ...["remaining","storage","recovery"].map(pool=>({pools:{...f.input.pools,[pool]:f.input.pools[pool as keyof typeof f.input.pools]+1}})),
    {reviewedOperationIds:[f.previous.operations[0].operationId]},{releaseTailYen:f.input.releaseTailYen+1},{releaseMonthlyCapYen:70000}])
    expect(() => setManagedMonthPlan(f.previous,{...f.input,...change},f.now)).toThrow();
  for (const change of [{forward:15},{forward:12},{monthlyCapYen:70001},{validUntil:"2026-12-01T00:00:00Z"},
    ...Object.keys(f.adjustment.executionEarmark).filter(k=>k!=="forecastBaseYen").map(k=>({executionEarmark:{...f.adjustment.executionEarmark,[k]:0}}))])
    expect(()=>managedStandardMonthAdjustmentSchema.parse({...f.adjustment,...change})).toThrow();
});
it("freezes review-scope funding and deadline and makes thirteen a hard stop", () => {
  const f=reviewScopeRepairFixture(),planned=setManagedMonthPlan(f.previous,f.input,f.now);
  const linked={...f.input,standardMonthAdjustment:{...f.adjustment,priorPlanDigest:managedDigest(planned.plans[2])}};
  const stoppedBeforeActivate=setManagedMonthPlan(planned,{...linked,standardMonthAdjustment:{...linked.standardMonthAdjustment,profileDigest:managedDigest(f.f.p),forward:13}},f.now);
  expect(stoppedBeforeActivate.operations).toEqual(planned.operations);
  expect(()=>checkManagedExecutionBudget(stoppedBeforeActivate,f.f.p,f.now)).toThrow();
  const active=activate(planned,f.p,f.now),next={...linked,standardMonthAdjustment:{...linked.standardMonthAdjustment,priorProfileDigest:managedDigest(f.p)}};
  for(const change of [undefined,f.f.adjustment,...[{validUntil:"2026-11-10T00:00:00Z"},{ownerApprovalDigest:digest(999)},{repairEpochDigest:digest(999)}].map(c=>({...next.standardMonthAdjustment,...c}))])
    expect(()=>setManagedMonthPlan(active,{...next,standardMonthAdjustment:change},f.now)).toThrow();
  expect(()=>setManagedMonthPlan(active,{...next,baseYen:next.baseYen+2353},f.now)).toThrow();
  const stopped=setManagedMonthPlan(active,{...next,standardMonthAdjustment:{...next.standardMonthAdjustment,forward:13}},f.now);
  expect(stopped.operations).toEqual(active.operations);
  expect(stopped.plans[2].baseYen).toBe(active.plans[2].baseYen);
  expect(()=>checkManagedExecutionBudget(stopped,f.p,f.now)).toThrow();
  expect(()=>activate(stopped,f.p,f.now)).toThrow();
  for(const profile of [null,undefined,f.f.p])expect(()=>checkManagedExecutionBudget(active,profile,f.now)).toThrow();
  expect(()=>checkManagedExecutionBudget(active,f.p,clock("2026-11-09T00:00:00Z"))).toThrow();
});
