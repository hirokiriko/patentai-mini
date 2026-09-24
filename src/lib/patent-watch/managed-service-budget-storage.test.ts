import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { emptyManagedBudgetUnits, MANAGED_SERVICE_KEY, managedBudgetProfileSchema, managedBudgetStateSchema } from "./managed-service-budget";
import { MANAGED_BUDGET_PREFIX, ManagedServiceBudgetStorage } from "./managed-service-budget-storage";
import { managedAdministrationReviewSchema, type ManagedAdministrationReview, type ManagedSettlementReview } from "./managed-budget-evidence";

const hash = (n: number) => n.toString(16).padStart(64, "0"), key = `${MANAGED_BUDGET_PREFIX}state.json`;
const openedKey = `${MANAGED_BUDGET_PREFIX}opened.json`, openingIntentKey = `${MANAGED_BUDGET_PREFIX}opening-intent.json`;
function request(kind: "watch" | "import" = "import") { return { operationId: randomUUID(), requestDigest: managedDigest(randomUUID()),
  scope: "release", kind, profileDigest: null, pricingDigest: hash(4), cases: [1], reservationYen: 600,
  units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, ...(kind === "watch" ? { starts: 1, normal: 41 } : { packages: 1, bytes: 1024 }) } }; }
function fixture() {
  const binding = { storageAccount: "fictional", container: "private-import", targetBindingHash: hash(1) };
  const initial = managedBudgetStateSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: hash(1),
    activeProfileDigest: null, cases: [], lastTrustedAt: "2026-09-22T00:00:00.000Z", releaseTailYen: 20_000,
    legacyUnknownYen: 2000, openingEvidenceDigest: hash(2), administration: [{ sequence: 1, digest: hash(2) }], plans: [{ month: "2026-09", baseYen: 10_000,
      pools: { remaining: 1000, storage: 1000, recovery: 1000 }, evidenceDigests: [hash(3)] }], operations: [] });
  const files = new Map([[key, { bytes: Buffer.from(JSON.stringify(initial)), etag: '"v1"' }]]), calls: string[] = [];
  files.set(openedKey, { bytes: Buffer.from(JSON.stringify({ schema: 1, reviewDigest: hash(2), initialStateDigest: hash(20) })), etag: '"opened"' });
  const created = new Map<string, string>();
  let counter = 1, lostAck: string | null = null, noDate = false, publicContainer = false, date = "Wed, 23 Sep 2026 00:00:00 GMT";
  let rejectStateWrite = false;
  let barrier: Promise<void> | undefined, release: (() => void) | undefined, reads = 0;
  const store = ManagedServiceBudgetStorage.withIdentity(binding, { async getToken() { return { token: "FICTIONAL_TOKEN", expiresOnTimestamp: Date.now() + 3600_000 }; } }, {
    async sendRequest(req) {
      const url = new URL(req.url), name = url.pathname.slice(binding.container.length + 2), headers = req.headers.clone();
      for (const k of headers.headerNames()) headers.remove(k);
      headers.set("x-ms-request-id", "fictional"); headers.set("x-ms-version", "2025-11-05");
      if (!noDate) headers.set("date", date);
      calls.push(`${req.method}:${name}`); let status = 200, bytes = Buffer.alloc(0), bodyAsText: string | undefined;
      if (url.searchParams.get("restype") === "container") { if (publicContainer) headers.set("x-ms-blob-public-access", "blob"); }
      else if (req.method === "PUT") {
        const createState = name === key && req.headers.get("if-none-match") === "*";
        if (name === key) {
          if (createState) expect(req.headers.get("if-match")).toBeUndefined();
          else { expect(req.headers.get("if-match")).toBeTruthy(); expect(req.headers.get("if-none-match")).toBeUndefined(); }
        }
        else { if (name !== openedKey && name !== openingIntentKey) expect(name).toMatch(new RegExp(`^${MANAGED_BUDGET_PREFIX}settlements/[a-f0-9-]+/[1-9][0-9]*\\.json$`));
          expect(req.headers.get("if-match")).toBeUndefined(); expect(req.headers.get("if-none-match")).toBe("*"); }
        if (name === key ? (rejectStateWrite || (createState ? files.has(name) : req.headers.get("if-match") !== files.get(name)?.etag)) : files.has(name)) status = 412;
        else { const etag = `"v${++counter}"`; files.set(name, { bytes: Buffer.from(req.body as Uint8Array), etag });
          if (!created.has(name)) created.set(name, date);
          headers.set("etag", etag); status = 201; if (lostAck === name) throw Error("PRIVATE_RAW_ERROR_MUST_NOT_ESCAPE"); }
      } else {
        const stored = files.get(name);
        if (!stored) { status = 404; headers.set("x-ms-error-code", "BlobNotFound"); headers.set("content-type", "application/xml"); bodyAsText = "<Error><Code>BlobNotFound</Code></Error>"; }
        else {
          if (req.method === "GET") {
            expect(req.headers.get("if-match")).toBe(stored.etag); bytes = Buffer.from(stored.bytes);
            if (barrier) { if (++reads === 2) release!(); await barrier; }
          }
          headers.set("content-length", String(stored.bytes.length)); headers.set("etag", stored.etag);
          if (created.has(name)) headers.set("x-ms-creation-time", created.get(name)!);
        }
      }
      return { request: req, status, headers, bodyAsText, readableStreamBody: Readable.from(bytes) };
    },
  });
  return { store, files, calls, created, current: () => managedBudgetStateSchema.parse(JSON.parse(files.get(key)!.bytes.toString())),
    loseAck: (name = key) => { lostAck = name; }, restoreAck: () => { lostAck = null; },
    rejectStateWrite: (value: boolean) => { rejectStateWrite = value; },
    omitDate: () => { noDate = true; }, makePublic: () => { publicContainer = true; },
    setDate: (v: string) => { date = v; }, raceReads: () => { barrier = new Promise<void>(resolve => { release = resolve; }); } };
}
it("uses the real SDK to allow only one concurrent watch/import reservation from the same ETag", async () => {
  const f = fixture(); f.raceReads();
  const results = await Promise.allSettled([f.store.reserve(request("watch")), f.store.reserve(request("import"))]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  expect(f.current().operations).toHaveLength(1); expect(f.current().releaseTailYen).toBe(19_400);
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(2);
});

function adminReviewed(f: ReturnType<typeof fixture>, action?: ManagedAdministrationReview["action"], changes: Partial<ManagedAdministrationReview> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), der = publicKey.export({ format: "der", type: "spki" });
  const pins = { publicKeySpkiBase64: der.toString("base64"), publicKeySha256: createHash("sha256").update(der).digest("hex"),
    ownerBindingHash: hash(8), targetBindingHash: hash(1), productionGoDigest: undefined as string | undefined };
  const fact = Buffer.from(JSON.stringify({ schema: 1, kind: "FICTIONAL_REVIEWED_ADMINISTRATION" }));
  const factDigest = createHash("sha256").update(fact).digest("hex"), factKey = `${MANAGED_BUDGET_PREFIX}evidence/${factDigest}.json`;
  f.files.set(factKey, { bytes: fact, etag: '"fact"' });
  const current = f.current();
  action ??= { kind: "month", processingMonth: "2026-09", baseYen: 10_001,
    pools: { remaining: 1000, storage: 1000, recovery: 1000 }, releaseTailYen: current.releaseTailYen, reviewedOperationIds: [] };
  if (action.kind === "open") action = { ...action, state: { ...action.state, openingEvidenceDigest: factDigest } };
  if (action.kind === "activate") {
    const p = managedBudgetProfileSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: hash(1), ownerBindingHash: hash(8),
      companyKey: "FICTIONAL_COMPANY", cases: [1], monthlyCapYen: 30_000,
      monthlyUnits: { ...emptyManagedBudgetUnits(), jobs: 2, minutes: 240, starts: 2, normal: 82 },
      pricingDigest: factDigest, measurementDigest: factDigest, goEvidenceDigest: factDigest });
    action = { kind: "activate", profileDigest: managedDigest(p), pricingDigest: factDigest, measurementDigest: factDigest, goEvidenceDigest: factDigest };
    f.files.set(`${MANAGED_BUDGET_PREFIX}profiles/${action.profileDigest}.json`, { bytes: Buffer.from(JSON.stringify(p)), etag: '"profile"' });
    pins.productionGoDigest = factDigest;
  }
  const review = managedAdministrationReviewSchema.parse({ schema: 1, purpose: "MANAGED_WATCH_ADMINISTRATION_REVIEW_V1", targetBindingHash: hash(1), ownerBindingHash: hash(8),
    sequence: action.kind === "open" ? 1 : current.administration.length + 1,
    previousReviewDigest: action.kind === "open" ? null : current.administration.at(-1)?.digest ?? null,
    expectedStateDigest: action.kind === "open" ? null : managedDigest(current),
    issuedAt: "2026-09-22T00:00:00Z", validUntil: "2026-09-25T00:00:00Z", sources: [{ digest: factDigest, bytes: fact.length }], action, ...changes });
  const envelope = { review, signature: sign(null, Buffer.from(managedDigest(review), "hex"), privateKey).toString("base64") };
  const digest = managedDigest(envelope);
  f.files.set(`${MANAGED_BUDGET_PREFIX}administration-reviews/${digest}.json`, { bytes: Buffer.from(JSON.stringify(envelope)), etag: '"review"' });
  return { digest, pins, envelope, factKey };
}
it("records reviewed month plans once and reconciles a lost admin CAS ACK without reapplying", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  const p = adminReviewed(f); f.loseAck();
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow("managed_budget_stopped");
  expect(f.current().plans[0].baseYen).toBe(10_001);
  expect(f.current().operations[0].reservationYen).toBe(600);
  expect(f.current().administration).toEqual([{ sequence: 1, digest: hash(2) }, { sequence: 2, digest: p.digest }]);
  f.restoreAck(); f.setDate("Sat, 26 Sep 2026 00:00:00 GMT"); const before = f.calls.length;
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins)).toEqual({ status: "already_applied" });
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it("opens only an explicitly signed ledger, preserving already claimed unknown release operations", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start"); await f.store.markUnknown(r.operationId);
  const prior = f.current(), p = adminReviewed(f, { kind: "open", state: { ...prior, administration: [] } }); f.files.delete(key); f.files.delete(openedKey);
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins, true)).toEqual({ status: "not_applied" });
  expect(f.files.has(key)).toBe(false);
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins)).toEqual({ status: "applied" });
  expect(f.current().operations).toEqual(prior.operations);
  expect(f.current().legacyUnknownYen).toBe(prior.legacyUnknownYen);
  expect(f.current().releaseTailYen).toBe(prior.releaseTailYen);
  const second = adminReviewed(f, { kind: "open", state: { ...prior, administration: [], operations: [] } });
  await expect(f.store.applyReviewedAdministration(second.digest, second.pins)).rejects.toThrow();
  expect(f.current().operations).toEqual(prior.operations);
});
it("never reapplies an opening snapshot after the opened ledger is lost", async () => {
  const f = fixture(), p = adminReviewed(f, { kind: "open", state: { ...f.current(), administration: [] } });
  f.files.delete(key); f.files.delete(openedKey);
  await f.store.applyReviewedAdministration(p.digest, p.pins);
  const r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start"); await f.store.markUnknown(r.operationId);
  f.files.delete(key); const before = f.calls.length;
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow("managed_budget_stopped");
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins, true)).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  expect(f.files.has(key)).toBe(false);
});
it.each(["intent", "state", "opened"])("reconciles an opening %s ACK loss and gates all business work until opened", async phase => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start"); await f.store.markUnknown(r.operationId);
  const prior = f.current(), p = adminReviewed(f, { kind: "open", state: { ...prior, administration: [] } });
  f.files.delete(key); f.files.delete(openedKey);
  f.loseAck(phase === "intent" ? openingIntentKey : phase === "state" ? key : openedKey);
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  f.restoreAck(); const before = f.calls.length;
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins, true)).toEqual({ status: phase === "opened" ? "already_applied" : "pending" });
  if (phase !== "opened") {
    await expect(f.store.reserve(request("watch"))).rejects.toThrow();
    await expect(f.store.claim(r.operationId, "start")).rejects.toThrow();
    await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "watch")).rejects.toThrow();
  }
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  f.setDate("Sat, 26 Sep 2026 00:00:00 GMT");
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins)).toEqual({ status: phase === "opened" ? "already_applied" : "applied" });
  expect(f.current().administration).toEqual([{ sequence: 1, digest: p.digest }]);
  expect(f.current().operations).toEqual(prior.operations); expect(f.current().releaseTailYen).toBe(prior.releaseTailYen);
  expect(f.current().lastTrustedAt).toBe(prior.lastTrustedAt);
});
it("refuses to finish an interrupted opening when its state differs from the signed initial snapshot", async () => {
  const f = fixture(), p = adminReviewed(f, { kind: "open", state: { ...f.current(), administration: [] } });
  f.files.delete(key); f.files.delete(openedKey); f.loseAck(key);
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  f.restoreAck(); const s = f.current(); s.legacyUnknownYen = 0; f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s));
  const before = f.calls.length;
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0); expect(f.files.has(openedKey)).toBe(false);
});
it("requires a new exact-state review after a competing reservation, never replacing it with stale figures", async () => {
  const f = fixture(), p = adminReviewed(f); await f.store.reserve(request("watch"));
  const before = f.calls.length;
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins, true)).toEqual({ status: "review_stale" });
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  const fresh = adminReviewed(f);
  expect(await f.store.applyReviewedAdministration(fresh.digest, fresh.pins)).toEqual({ status: "applied" });
  expect(f.current().operations).toHaveLength(1);
});
it("allows one of two concurrent administration reviews and retains a single immutable sequence", async () => {
  const f = fixture(), a = adminReviewed(f), b = adminReviewed(f); f.raceReads();
  const results = await Promise.allSettled([f.store.applyReviewedAdministration(a.digest, a.pins), f.store.applyReviewedAdministration(b.digest, b.pins)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(f.current().administration).toHaveLength(2);
});
it.each(["future-month", "sequence", "previous", "fact", "expired"])("rejects invalid %s administration without a state write", async reason => {
  const f = fixture(), changes: Partial<ManagedAdministrationReview> = {};
  if (reason === "sequence") changes.sequence = 3;
  if (reason === "previous") changes.previousReviewDigest = hash(90);
  const action: ManagedAdministrationReview["action"] = { kind: "month", processingMonth: reason === "future-month" ? "2026-10" : "2026-09",
    baseYen: 10_000, pools: { remaining: 1000, storage: 1000, recovery: 1000 }, releaseTailYen: 20_000, reviewedOperationIds: [] };
  const p = adminReviewed(f, action, changes);
  if (reason === "fact") f.files.get(p.factKey)!.bytes = Buffer.from("{}");
  if (reason === "expired") f.setDate("Sat, 26 Sep 2026 00:00:00 GMT");
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it("activates only a signed profile whose GO digest is independently installed", async () => {
  const f = fixture(), p = adminReviewed(f, { kind: "activate", profileDigest: hash(1), goEvidenceDigest: hash(1), measurementDigest: hash(1), pricingDigest: hash(1) });
  await expect(f.store.applyReviewedAdministration(p.digest, { ...p.pins, productionGoDigest: undefined })).rejects.toThrow();
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  expect(await f.store.applyReviewedAdministration(p.digest, p.pins)).toEqual({ status: "applied" });
  expect(f.current().activeProfileDigest).not.toBeNull();
});

function reviewed(f: ReturnType<typeof fixture>, r: ReturnType<typeof request>, sequence = 1, previousProofDigest: string | null = null,
  changes: Partial<ManagedSettlementReview> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), der = publicKey.export({ format: "der", type: "spki" });
  const pins = { publicKeySpkiBase64: der.toString("base64"), publicKeySha256: createHash("sha256").update(der).digest("hex"),
    ownerBindingHash: hash(8), targetBindingHash: hash(1) };
  const fact = Buffer.from(JSON.stringify({ schema: 1, operationId: r.operationId, status: "fictional_terminal", sequence }));
  const factDigest = createHash("sha256").update(fact).digest("hex"), factKey = `${MANAGED_BUDGET_PREFIX}evidence/${factDigest}.json`;
  f.files.set(factKey, { bytes: fact, etag: '"fact"' });
  const units = { ...r.units }, review: ManagedSettlementReview = { schema: 1, purpose: "MANAGED_WATCH_SETTLEMENT_REVIEW_V1",
    targetBindingHash: hash(1), ownerBindingHash: hash(8), operationId: r.operationId, requestDigest: r.requestDigest,
    pricingDigest: r.pricingDigest, sequence, previousProofDigest, issuedAt: "2026-09-22T00:00:00Z", validUntil: "2026-09-25T00:00:00Z",
    sources: [{ digest: factDigest, bytes: fact.length }], finalizedUnits: units,
    unitEvidence: Object.keys(units).map(unit => ({ unit: unit as keyof typeof units, sourceDigest: factDigest })),
    cost: { operationId: r.operationId, sourceDigest: factDigest, observedYen: 100, finalYen: 100 }, ...changes };
  const envelope = { review, signature: sign(null, Buffer.from(managedDigest(review), "hex"), privateKey).toString("base64") };
  const digest = managedDigest(envelope), reviewKey = `${MANAGED_BUDGET_PREFIX}settlement-reviews/${digest}.json`;
  const slotKey = `${MANAGED_BUDGET_PREFIX}settlements/${r.operationId}/${sequence}.json`;
  f.files.set(reviewKey, { bytes: Buffer.from(JSON.stringify(envelope)), etag: '"review"' });
  return { pins, digest, factKey, reviewKey, slotKey, envelope };
}
it("settles only a signed attributed review and rereads the immutable slot without a second refund", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start");
  const p = reviewed(f, r), before = f.current().releaseTailYen;
  expect(await f.store.settleReviewed(p.digest, p.pins, true)).toEqual({ status: "not_staged" });
  expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: "applied" });
  expect(f.current().releaseTailYen).toBe(before + 500);
  const calls = f.calls.length; f.setDate("Thu, 01 Oct 2026 00:00:00 GMT");
  expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: "already_applied" });
  expect(f.calls.slice(calls).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  expect(f.current().releaseTailYen).toBe(before + 500);
});
it.each(["slot", "state"])("retains %s writes with lost ACK and requires explicit read-back before applying anything else", async phase => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start");
  const p = reviewed(f, r); f.loseAck(phase === "slot" ? p.slotKey : key);
  const calls = f.calls.length;
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.slice(calls).filter(c => c === `PUT:${p.slotKey}`)).toHaveLength(1);
  expect(f.current().operations[0].actualYen).toBe(phase === "slot" ? null : 100);
  const after = f.calls.length;
  expect(await f.store.settleReviewed(p.digest, p.pins, true)).toEqual({ status: phase === "slot" ? "pending" : "already_applied" });
  expect(f.calls.slice(after).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  f.restoreAck(); expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: phase === "slot" ? "applied" : "already_applied" });
  expect(f.current().releaseTailYen).toBe(19_900);
});
it("preserves a staged proof after CAS conflict and rejects a competing proof at the same sequence", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  const p = reviewed(f, r); f.rejectStateWrite(true);
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow();
  expect(f.current().operations[0].lastProofSequence).toBe(0);
  const competing = reviewed(f, r);
  await expect(f.store.settleReviewed(competing.digest, competing.pins)).rejects.toThrow();
  f.rejectStateWrite(false); expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: "applied" });
});
it("recovers a proof registered before expiry after a lost slot ACK, using Blob creation time", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  const p = reviewed(f, r); f.loseAck(p.slotKey);
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow();
  f.restoreAck(); f.setDate("Sat, 26 Sep 2026 00:00:00 GMT");
  expect(await f.store.settleReviewed(p.digest, p.pins, true)).toEqual({ status: "pending" });
  expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: "applied" });
  expect(f.current().operations[0].actualYen).toBe(100);
});
it("reconciles an old applied proof from its immutable slot after its fingerprint has left the recent ring", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  let previous: string | null = null, first: ReturnType<typeof reviewed> | undefined;
  for (let sequence = 1; sequence <= 66; sequence++) {
    const p = reviewed(f, r, sequence, previous); first ??= p;
    expect(await f.store.settleReviewed(p.digest, p.pins)).toEqual({ status: "applied" }); previous = p.digest;
  }
  const current = f.current().operations[0];
  expect(current.lastProofSequence).toBe(66); expect(current.settlements).toHaveLength(64);
  expect(current.settlements.some(s => s.evidenceDigest === first!.digest)).toBe(false);
  expect(current.reviewRequired).toBe(true);
  f.setDate("Sat, 26 Sep 2026 00:00:00 GMT"); const before = f.calls.length;
  expect(await f.store.settleReviewed(first!.digest, first!.pins)).toEqual({ status: "already_applied" });
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  expect(f.current().releaseTailYen).toBe(19_900);
});
it.each(["absent", "early", "late"])("rejects %s immutable creation evidence for an existing proof", async reason => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  const p = reviewed(f, r); f.loseAck(p.slotKey);
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow();
  f.restoreAck();
  if (reason === "absent") f.created.delete(p.slotKey);
  if (reason === "early") f.created.set(p.slotKey, "Mon, 21 Sep 2026 00:00:00 GMT");
  if (reason === "late") f.created.set(p.slotKey, "Sat, 26 Sep 2026 00:00:00 GMT");
  const before = f.calls.length;
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow();
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it.each(["fact", "bytes", "request", "pricing", "sequence", "previous", "expired", "slot"])("rejects %s mismatch before settlement writes", async reason => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r);
  const changes: Partial<ManagedSettlementReview> = {};
  if (reason === "request") changes.requestDigest = hash(90);
  if (reason === "pricing") changes.pricingDigest = hash(90);
  if (reason === "sequence") changes.sequence = 2;
  if (reason === "previous") changes.previousProofDigest = hash(90);
  const p = reviewed(f, r, 1, null, changes);
  if (reason === "fact") f.files.get(p.factKey)!.bytes[0] = 91;
  if (reason === "bytes") f.files.get(p.factKey)!.bytes = Buffer.from("{}");
  if (reason === "expired") f.setDate("Sat, 26 Sep 2026 00:00:00 GMT");
  if (reason === "slot") f.files.set(p.slotKey, { bytes: Buffer.from("{}"), etag: '"bad-slot"' });
  const before = f.calls.length;
  await expect(f.store.settleReviewed(p.digest, p.pins)).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
  expect(f.current().operations[0].actualYen).toBeNull();
});
it("never retries a lost write ACK or returns execution permission from reservation read-back", async () => {
  const f = fixture(), r = request(); f.loseAck();
  await expect(f.store.reserve(r)).rejects.toThrow("managed_budget_stopped");
  expect(f.current().operations).toHaveLength(1); expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(1);
  expect(await f.store.reserve(r)).toEqual({ created: false });
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(1);
  expect(f.current().operations[0].start).toBe("ready");
});
it("allows one phase claim and retains that claim when its ACK is lost", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); f.loseAck();
  let externalStarts = 0;
  await expect(f.store.claim(r.operationId, "start").then(() => { externalStarts++; })).rejects.toThrow("managed_budget_stopped");
  await expect(f.store.claim(r.operationId, "start").then(() => { externalStarts++; })).rejects.toThrow("managed_budget_stopped");
  expect(externalStarts).toBe(0); expect(f.current().operations[0].start).toBe("claimed");
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(2);
});
it("shares one reservation across import stage and start and permits its already accepted unknown worker", async () => {
  const f = fixture(), r = request(); await f.store.reserve(r); await f.store.claim(r.operationId, "stage");
  await expect(f.store.claim(r.operationId, "start")).rejects.toThrow();
  await f.store.confirmStage(r.operationId, r.requestDigest, hash(9)); await f.store.claim(r.operationId, "start");
  await f.store.markUnknown(r.operationId);
  expect(await f.store.verifyClaimed(r.operationId, r.requestDigest, "import")).toMatchObject({ processingMonth: "2026-09" });
  expect(f.current().operations).toHaveLength(1); expect(f.current().operations[0].unknown).toBe(true);
  await expect(f.store.verifyClaimed(r.operationId, hash(90), "import")).rejects.toThrow();
  await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "watch")).rejects.toThrow();
});
it.each(["missing", "date", "public", "target", "future", "unreviewed"])("fails closed on %s ledger evidence without initialization or writes", async reason => {
  const f = fixture();
  if (reason === "missing") f.files.delete(key);
  if (reason === "date") f.omitDate();
  if (reason === "public") f.makePublic();
  if (reason === "target") { const s = f.current(); s.targetBindingHash = hash(99); f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s)); }
  if (reason === "future") f.setDate("Mon, 21 Sep 2026 00:00:00 GMT");
  if (reason === "unreviewed") { const s = f.current(); s.administration = []; f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s)); }
  await expect(f.store.reserve(request())).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it("checks actual worker time at the JST month boundary rather than trusting the submitted month", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start");
  f.setDate("Wed, 30 Sep 2026 15:00:01 GMT");
  await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "watch")).rejects.toThrow();
  await expect(f.store.reserve({ ...request(), processingMonth: "2026-09" })).rejects.toThrow();
});
it.each(["intent", "duplicate", "plan", "phase", "future", "extended", "incomplete-final", "missing-proof"])("rejects persisted %s corruption during worker read-back", async reason => {
  const f = fixture(), r = request(); await f.store.reserve(r); await f.store.claim(r.operationId, "stage");
  await f.store.confirmStage(r.operationId, r.requestDigest, hash(9)); await f.store.claim(r.operationId, "start");
  const s = f.current(), o = s.operations[0];
  if (reason === "intent") o.units.jobs = 0;
  if (reason === "duplicate") s.operations.push(o);
  if (reason === "plan") s.plans = [];
  if (reason === "phase") o.stage = "unused";
  if (reason === "future") { o.reservedAt = "2026-09-25T00:00:00.000Z"; o.expiresAt = "2026-09-25T06:00:00.000Z"; }
  if (reason === "extended") o.expiresAt = "2026-09-29T06:00:00.000Z";
  if (reason === "incomplete-final") o.actualYen = 1;
  if (reason === "missing-proof") o.lastProofSequence = 1;
  f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s));
  await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "import")).rejects.toThrow("managed_budget_stopped");
});
