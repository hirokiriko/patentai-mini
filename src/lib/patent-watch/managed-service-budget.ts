import { z } from "zod";
import { managedDigest } from "./managed-claims";

// One service, one private ledger. Neither the profile version nor a caller's
// reporting period selects a new ledger or resets the release counters.
export const MANAGED_SERVICE_KEY = "patentai-standard-managed-watch";
export const managedReleaseCaps = { jobs: 24, minutes: 2880, starts: 40, normal: 900, fast: 80,
  packages: 64, bytes: 96 * 1024 ** 3, forward: 8, rollback: 2 } as const;
type Unit = keyof typeof managedReleaseCaps;
const unitKeys = Object.keys(managedReleaseCaps) as Unit[];
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const quantity = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const yen = z.number().int().nonnegative().max(1_000_000_000);
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const cases = z.array(z.number().int().positive().max(2147483647)).max(5).refine(v => new Set(v).size === v.length);
export const managedBudgetUnitsSchema = z.object({ jobs: quantity, minutes: quantity, starts: quantity,
  normal: quantity, fast: quantity, packages: quantity, bytes: quantity, forward: quantity, rollback: quantity }).strict();
export type ManagedBudgetUnits = z.infer<typeof managedBudgetUnitsSchema>;
export const emptyManagedBudgetUnits = (): ManagedBudgetUnits => ({ jobs: 0, minutes: 0, starts: 0, normal: 0,
  fast: 0, packages: 0, bytes: 0, forward: 0, rollback: 0 });
const pools = z.object({ remaining: yen, storage: yen, recovery: yen }).strict();
type Pool = keyof z.infer<typeof pools>;
const poolKeys: Pool[] = ["remaining", "storage", "recovery"];
export const managedBudgetProfileSchema = z.object({ schema: z.literal(1), serviceKey: z.literal(MANAGED_SERVICE_KEY),
  targetBindingHash: hash, ownerBindingHash: hash, companyKey: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), cases,
  monthlyCapYen: z.number().int().positive().max(30_000), monthlyUnits: managedBudgetUnitsSchema,
  pricingDigest: hash, measurementDigest: hash, goEvidenceDigest: hash }).strict();
export type ManagedBudgetProfile = z.infer<typeof managedBudgetProfileSchema>;
export const managedBudgetRequestSchema = z.object({ operationId: z.uuidv4(), requestDigest: hash,
  scope: z.enum(["release", "standard"]), kind: z.enum(["import", "watch", "delivery", "backup", "recovery", "deploy", "validation"]),
  profileDigest: hash.nullable(), pricingDigest: hash, cases, reservationYen: yen.refine(v => v > 0), units: managedBudgetUnitsSchema }).strict();
type Request = z.infer<typeof managedBudgetRequestSchema>;
const operationSchema = managedBudgetRequestSchema.extend({ intentDigest: hash, processingMonth: month,
  reservedAt: z.iso.datetime(), expiresAt: z.iso.datetime(), stage: z.enum(["unused", "ready", "claimed", "done"]),
  stageDigest: hash.optional(),
  start: z.enum(["ready", "claimed"]), unknown: z.boolean(), actualYen: yen.nullable(), observedYen: yen.nullable(), reviewRequired: z.boolean(),
  knownUnits: managedBudgetUnitsSchema.partial().strict(), evidenceDigests: z.array(hash).max(64),
  evidenceChainDigest: hash, lastProofSequence: quantity,
  settlements: z.array(z.object({ sequence: quantity.refine(v => v > 0), evidenceDigest: hash, proofDigest: hash }).strict()).max(64) }).strict();
type Operation = z.infer<typeof operationSchema>;
const planSchema = z.object({ month, baseYen: yen, pools, pricingDigest: hash, evidenceDigests: z.array(hash).min(1).max(128) }).strict();
export const managedBudgetStateSchema = z.object({ schema: z.literal(1), serviceKey: z.literal(MANAGED_SERVICE_KEY),
  targetBindingHash: hash, activeProfileDigest: hash.nullable(), cases, lastTrustedAt: z.iso.datetime(),
  releaseTailYen: yen, legacyUnknownYen: yen, openingEvidenceDigest: hash,
  administration: z.array(z.object({ sequence: quantity.refine(v => v > 0), digest: hash }).strict()).max(1200),
  plans: z.array(planSchema).max(1200), operations: z.array(operationSchema).max(10_000) }).strict();
export type ManagedBudgetState = z.infer<typeof managedBudgetStateSchema>;
// Created only by the fixed private-Blob adapter. Never accept these fields from stdin/HTTP.
export type ManagedBudgetClock = { blobDate: Date; maximumActionMs: number };
export class ManagedBudgetError extends Error { constructor() { super("managed_budget_stopped"); } }
function check(value: unknown): asserts value { if (!value) throw new ManagedBudgetError(); }
function sum(values: number[]) { const n = values.reduce((a, b) => a + b, 0); check(Number.isSafeInteger(n)); return n; }
function intent(o: Request): Request { return { operationId: o.operationId, requestDigest: o.requestDigest, scope: o.scope,
  kind: o.kind, profileDigest: o.profileDigest, pricingDigest: o.pricingDigest, cases: o.cases,
  reservationYen: o.reservationYen, units: o.units }; }
function cost(o: Operation) { return Math.max(o.actualYen ?? o.reservationYen, o.observedYen ?? 0); }
function used(o: Operation, k: Unit) { return o.knownUnits[k] ?? o.units[k]; }
function closed(o: Operation) { return o.actualYen !== null && o.actualYen >= (o.observedYen ?? 0) &&
  unitKeys.every(k => o.knownUnits[k] !== undefined); }
function poolOf(o: Request): Pool { return o.kind === "recovery" || o.units.rollback > 0 ? "recovery" :
  o.kind === "delivery" || o.kind === "backup" ? "storage" : "remaining"; }
function poolUsed(s: ManagedBudgetState, m: string, pool: Pool) {
  return sum(s.operations.filter(o => o.processingMonth === m && poolOf(o) === pool).map(cost));
}
export function managedBudgetForecast(s: ManagedBudgetState, m: string) {
  const plan = s.plans.find(p => p.month === m); check(plan);
  const carry = sum([s.legacyUnknownYen, ...s.operations.filter(o => o.processingMonth < m && !closed(o)).map(cost)]);
  // Operations allocate a pool, not a second charge. Observed overruns remain visible.
  return sum([plan.baseYen, carry, ...poolKeys.map(p => Math.max(plan.pools[p], poolUsed(s, m, p)))]);
}
function totals(s: ManagedBudgetState, scope: "release" | "month", m: string) {
  const result = emptyManagedBudgetUnits();
  for (const k of unitKeys) result[k] = sum(s.operations.map(o => scope === "release" ?
    (o.scope === "release" ? used(o, k) : 0) : o.processingMonth === m ? used(o, k) :
      o.processingMonth < m && !closed(o) && o.knownUnits[k] === undefined ? o.units[k] : 0));
  return result;
}
function seal(value: ManagedBudgetState) {
  const s = managedBudgetStateSchema.parse(value);
  check(new Set(s.plans.map(p => p.month)).size === s.plans.length);
  check(new Set(s.operations.map(o => o.operationId)).size === s.operations.length);
  check(new Set(s.operations.map(o => o.requestDigest)).size === s.operations.length);
  check(new Set(s.administration.map(r => r.digest)).size === s.administration.length &&
    s.administration.every((r, i) => r.sequence === i + 1));
  check(Buffer.byteLength(JSON.stringify({ ...s, operations: [] })) <= 1024 ** 2);
  check(s.operations.length * 20 * 1024 + 1024 ** 2 <= 16 * 1024 ** 2);
  for (const o of s.operations) {
    check(o.intentDigest === managedDigest(intent(o)) && o.cases.every(id => s.cases.includes(id)));
    check(s.plans.some(p => p.month === o.processingMonth));
    const reserved = Date.parse(o.reservedAt), expiry = Date.parse(o.expiresAt), jst = new Date(reserved + 9 * 60 * 60_000);
    const monthEnd = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60_000;
    check(reserved <= Date.parse(s.lastTrustedAt) && o.processingMonth === jst.toISOString().slice(0, 7) &&
      expiry > reserved && expiry <= Math.min(reserved + 6 * 60 * 60_000, monthEnd));
    check(o.scope === "standard" ? o.profileDigest !== null : o.profileDigest === null);
    check(o.kind === "import" ? o.stage !== "unused" && (o.start !== "claimed" || o.stage === "done") : o.stage === "unused");
    if (o.stageDigest) check(o.kind === "import" && o.stage === "done");
    check(o.actualYen === null || unitKeys.every(k => o.knownUnits[k] !== undefined));
    check(o.settlements.length === Math.min(o.lastProofSequence, 64));
    check(new Set(o.settlements.map(p => p.evidenceDigest)).size === o.settlements.length &&
      o.settlements.every((p, i) => p.sequence === o.lastProofSequence - o.settlements.length + i + 1));
  }
  check(Buffer.byteLength(JSON.stringify(s)) <= 16 * 1024 ** 2);
  // Do not reject recorded overruns: evidence must survive even when admission stops.
  return s;
}
export function validateManagedBudgetState(value: unknown, expectedTargetBindingHash: string) {
  const s = seal(managedBudgetStateSchema.parse(value)); check(s.targetBindingHash === hash.parse(expectedTargetBindingHash)); return s;
}
function current(value: unknown, clock: ManagedBudgetClock) {
  const s = seal(managedBudgetStateSchema.parse(value)), ms = clock.blobDate.getTime();
  check(Number.isFinite(ms) && ms >= Date.parse(s.lastTrustedAt));
  check(Number.isSafeInteger(clock.maximumActionMs) && clock.maximumActionMs > 0 && clock.maximumActionMs <= 6 * 60 * 60_000);
  const jst = new Date(ms + 9 * 60 * 60_000), m = jst.toISOString().slice(0, 7);
  const end = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60_000;
  s.lastTrustedAt = clock.blobDate.toISOString();
  return { s, ms, month: m, end };
}
function active(s: ManagedBudgetState, value: unknown) {
  const p = managedBudgetProfileSchema.parse(value);
  check(managedDigest(p) === s.activeProfileDigest && p.targetBindingHash === s.targetBindingHash);
  for (const k of unitKeys) check(p.monthlyUnits[k] <= managedReleaseCaps[k]);
  return p;
}
function admit(s: ManagedBudgetState, m: string, profile?: ManagedBudgetProfile) {
  check(!s.operations.some(o => o.reviewRequired));
  check(managedBudgetForecast(s, m) <= (profile?.monthlyCapYen ?? 30_000));
  check(sum([s.releaseTailYen, ...s.operations.filter(o => o.scope === "release").map(cost)]) <= 50_000);
  const release = totals(s, "release", m);
  for (const k of unitKeys) check(release[k] <= managedReleaseCaps[k]);
  if (profile) { check(profile.pricingDigest === s.plans.find(p => p.month === m)?.pricingDigest);
    const total = totals(s, "month", m); for (const k of unitKeys) check(total[k] <= profile.monthlyUnits[k]); }
}
function find(s: ManagedBudgetState, id: string) { const o = s.operations.find(o => o.operationId === id); check(o); return o; }
function evidence(o: Operation, digest: string) {
  hash.parse(digest);
  if (o.evidenceDigests.includes(digest)) return;
  o.evidenceChainDigest = managedDigest({ previous: o.evidenceChainDigest, digest });
  if (o.evidenceDigests.length === 64) o.reviewRequired = true;
  o.evidenceDigests = [...o.evidenceDigests, digest].slice(-64);
}

/** Administrative evidence must be checked by the adapter before these transitions. */
export function setManagedMonthPlan(value: unknown, input: { baseYen: number; pools: z.infer<typeof pools>;
  pricingDigest: string; evidenceDigest: string; releaseTailYen: number; reviewedOperationIds?: string[] }, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock), old = s.plans.find(p => p.month === m);
  const plan = planSchema.parse({ month: m, baseYen: input.baseYen, pools: input.pools, pricingDigest: input.pricingDigest,
    evidenceDigests: [...new Set([...(old?.evidenceDigests ?? []), hash.parse(input.evidenceDigest)])] });
  if (old) s.plans[s.plans.indexOf(old)] = plan; else s.plans.push(plan);
  s.releaseTailYen = yen.parse(input.releaseTailYen);
  for (const id of input.reviewedOperationIds ?? []) { const o = find(s, z.uuidv4().parse(id)); evidence(o, input.evidenceDigest); o.reviewRequired = false; }
  for (const pool of poolKeys) check(poolUsed(s, m, pool) <= plan.pools[pool]);
  return seal(s); // An over-cap plan is recorded, never a permission to start.
}
export function activateManagedBudgetProfile(value: unknown, profile: unknown, checkedEvidence: {
  profileDigest: string; goEvidenceDigest: string; measurementDigest: string; pricingDigest: string;
}, clock: ManagedBudgetClock) {
  const { s, month: m } = current(value, clock), p = managedBudgetProfileSchema.parse(profile);
  check(p.targetBindingHash === s.targetBindingHash && managedDigest(p) === checkedEvidence.profileDigest &&
    p.goEvidenceDigest === checkedEvidence.goEvidenceDigest && p.measurementDigest === checkedEvidence.measurementDigest && p.pricingDigest === checkedEvidence.pricingDigest);
  s.cases = [...new Set([...s.cases, ...p.cases])].sort((a, b) => a - b); check(s.cases.length <= 5);
  s.activeProfileDigest = managedDigest(p); active(s, p); admit(s, m, p);
  return seal(s);
}
export function reserveManagedBudget(value: unknown, request: unknown, profile: unknown, clock: ManagedBudgetClock) {
  const { s, ms, month: m, end } = current(value, clock), r = managedBudgetRequestSchema.parse(request);
  r.cases.sort((a, b) => a - b);
  const previous = s.operations.find(o => o.operationId === r.operationId || o.requestDigest === r.requestDigest);
  if (previous) { check(previous.operationId === r.operationId && previous.intentDigest === managedDigest(r)); return { state: s, created: false }; }
  // Reserve space for every operation's bounded final evidence, not only today's
  // small unclosed row. Existing rows are never deleted to obtain another slot.
  check((s.operations.length + 1) * 20 * 1024 + 1024 ** 2 <= 16 * 1024 ** 2 && ms + clock.maximumActionMs < end);
  const p = r.scope === "standard" ? active(s, profile) : undefined;
  if (p) check(r.profileDigest === managedDigest(p) && r.pricingDigest === p.pricingDigest && r.cases.every(id => p.cases.includes(id)));
  else check(r.profileDigest === null);
  s.cases = [...new Set([...s.cases, ...r.cases])].sort((a, b) => a - b); check(s.cases.length <= 5);
  const plan = s.plans.find(p => p.month === m), pool = poolOf(r); check(plan);
  check(r.pricingDigest === plan.pricingDigest);
  check(poolUsed(s, m, pool) + r.reservationYen <= plan.pools[pool]);
  if (r.scope === "release") { check(s.releaseTailYen >= r.reservationYen); s.releaseTailYen -= r.reservationYen; }
  s.operations.push({ ...r, intentDigest: managedDigest(r), processingMonth: m, reservedAt: s.lastTrustedAt,
    expiresAt: new Date(Math.min(ms + 6 * 60 * 60_000, end)).toISOString(), stage: r.kind === "import" ? "ready" : "unused",
    start: "ready", unknown: false, actualYen: null, observedYen: null, reviewRequired: false, knownUnits: {}, evidenceDigests: [],
    evidenceChainDigest: managedDigest(r), lastProofSequence: 0, settlements: [] });
  admit(s, m, p); return { state: seal(s), created: true };
}
export function claimManagedBudgetPhase(value: unknown, id: string, phase: "stage" | "start", profile: unknown, clock: ManagedBudgetClock) {
  const { s, ms, month: m, end } = current(value, clock), o = find(s, id);
  check(!o.unknown && o.actualYen === null && o.processingMonth === m && ms + clock.maximumActionMs < Math.min(end, Date.parse(o.expiresAt)));
  check(o.pricingDigest === s.plans.find(p => p.month === m)?.pricingDigest);
  const p = o.scope === "standard" ? active(s, profile) : undefined;
  if (p) check(o.profileDigest === managedDigest(p));
  admit(s, m, p);
  if (phase === "stage") { check(o.kind === "import" && o.stage === "ready"); o.stage = "claimed"; }
  else { check(o.start === "ready" && (o.stage === "unused" || o.stage === "done")); o.start = "claimed"; }
  return seal(s);
}
export function confirmManagedBudgetStage(value: unknown, id: string, requestDigest: string, stageDigest: string, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, id);
  check(o.requestDigest === requestDigest && o.stage === "claimed" && o.start === "ready");
  o.stage = "done"; o.stageDigest = hash.parse(stageDigest); o.unknown = false; evidence(o, stageDigest); return seal(s);
}
export function markManagedBudgetUnknown(value: unknown, id: string, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, id); if (!closed(o)) o.unknown = true; return seal(s);
}
export function settleManagedBudget(value: unknown, proof: { operationId: string; requestDigest: string; sequence: number; evidenceDigest: string;
  knownUnits: Partial<ManagedBudgetUnits>; observedYen?: number; actualYen?: number }, clock: ManagedBudgetClock) {
  const { s } = current(value, clock), o = find(s, proof.operationId); check(o.requestDigest === proof.requestDigest);
  const known = managedBudgetUnitsSchema.partial().strict().parse(proof.knownUnits);
  const sequence = quantity.refine(v => v > 0).parse(proof.sequence);
  const proofDigest = managedDigest({ operationId: o.operationId, requestDigest: o.requestDigest, sequence,
    evidenceDigest: hash.parse(proof.evidenceDigest), knownUnits: known,
    ...(proof.actualYen === undefined ? {} : { actualYen: yen.parse(proof.actualYen) }),
    ...(proof.observedYen === undefined ? {} : { observedYen: yen.parse(proof.observedYen) }) });
  const previous = o.settlements.find(p => p.evidenceDigest === proof.evidenceDigest);
  if (previous) {
    check(previous.proofDigest === proofDigest);
    return seal(managedBudgetStateSchema.parse(value));
  }
  // Older compacted proofs require adapter read-back of the immutable sequence
  // slot. A hash chain alone is not evidence that an arbitrary proof was applied.
  check(sequence === o.lastProofSequence + 1);
  check(!o.evidenceDigests.includes(proof.evidenceDigest));
  for (const k of unitKeys) if (known[k] !== undefined) {
    check(o.knownUnits[k] === undefined || known[k]! >= o.knownUnits[k]!);
    if (known[k]! > o.units[k] || (o.knownUnits[k] !== undefined && known[k]! > o.knownUnits[k]!)) o.reviewRequired = true;
    o.knownUnits[k] = known[k];
  }
  if (proof.observedYen !== undefined) {
    const amount = yen.parse(proof.observedYen); check(amount >= (o.observedYen ?? 0));
    if (amount > cost(o)) o.reviewRequired = true;
    o.observedYen = amount;
  }
  if (proof.actualYen !== undefined) {
    const actual = yen.parse(proof.actualYen); check(unitKeys.every(k => o.knownUnits[k] !== undefined));
    check(actual >= (o.actualYen ?? 0) && actual >= (o.observedYen ?? 0));
    if (actual > o.reservationYen || (o.actualYen !== null && actual > o.actualYen)) o.reviewRequired = true;
    if (o.actualYen === null && o.scope === "release" && actual < o.reservationYen) s.releaseTailYen += o.reservationYen - actual;
    o.actualYen = actual;
  }
  evidence(o, proof.evidenceDigest); o.lastProofSequence = sequence;
  o.settlements = [...o.settlements, { sequence, evidenceDigest: proof.evidenceDigest, proofDigest }].slice(-64);
  o.unknown = !closed(o);
  return seal(s); // Overrun is evidence, not grounds to discard the observed bill.
}
