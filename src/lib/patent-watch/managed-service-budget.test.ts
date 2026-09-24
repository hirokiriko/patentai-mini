import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { MANAGED_SERVICE_KEY, managedReleaseCaps, emptyManagedBudgetUnits, managedBudgetStateSchema,
  managedBudgetForecast, reserveManagedBudget, claimManagedBudgetPhase, confirmManagedBudgetStage,
  markManagedBudgetUnknown, settleManagedBudget as settleSequence, setManagedMonthPlan, activateManagedBudgetProfile,
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
