import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { managedDigest } from "./managed-claims";
import { emptyManagedBudgetUnits, MANAGED_SERVICE_KEY, managedBudgetStateSchema } from "./managed-service-budget";
import { MANAGED_BUDGET_PREFIX, ManagedServiceBudgetStorage } from "./managed-service-budget-storage";

const hash = (n: number) => n.toString(16).padStart(64, "0"), key = `${MANAGED_BUDGET_PREFIX}state.json`;
function request(kind: "watch" | "import" = "import") { return { operationId: randomUUID(), requestDigest: managedDigest(randomUUID()),
  scope: "release", kind, profileDigest: null, pricingDigest: hash(4), cases: [1], reservationYen: 600,
  units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, ...(kind === "watch" ? { starts: 1, normal: 41 } : { packages: 1, bytes: 1024 }) } }; }
function fixture() {
  const binding = { storageAccount: "fictional", container: "private-import", targetBindingHash: hash(1) };
  const initial = managedBudgetStateSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: hash(1),
    activeProfileDigest: null, cases: [], lastTrustedAt: "2026-09-22T00:00:00.000Z", releaseTailYen: 20_000,
    legacyUnknownYen: 2000, openingEvidenceDigest: hash(2), plans: [{ month: "2026-09", baseYen: 10_000,
      pools: { remaining: 1000, storage: 1000, recovery: 1000 }, evidenceDigests: [hash(3)] }], operations: [] });
  const files = new Map([[key, { bytes: Buffer.from(JSON.stringify(initial)), etag: '"v1"' }]]), calls: string[] = [];
  let counter = 1, lostAck = false, noDate = false, publicContainer = false, date = "Wed, 23 Sep 2026 00:00:00 GMT";
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
        expect(name).toBe(key); expect(req.headers.get("if-match")).toBeTruthy();
        expect(req.headers.get("if-none-match")).toBeUndefined();
        if (req.headers.get("if-match") !== files.get(name)?.etag) status = 412;
        else { const etag = `"v${++counter}"`; files.set(name, { bytes: Buffer.from(req.body as Uint8Array), etag });
          headers.set("etag", etag); status = 201; if (lostAck) throw Error("PRIVATE_RAW_ERROR_MUST_NOT_ESCAPE"); }
      } else {
        const stored = files.get(name);
        if (!stored) { status = 404; headers.set("x-ms-error-code", "BlobNotFound"); headers.set("content-type", "application/xml"); bodyAsText = "<Error><Code>BlobNotFound</Code></Error>"; }
        else {
          if (req.method === "GET") {
            expect(req.headers.get("if-match")).toBe(stored.etag); bytes = Buffer.from(stored.bytes);
            if (barrier) { if (++reads === 2) release!(); await barrier; }
          }
          headers.set("content-length", String(stored.bytes.length)); headers.set("etag", stored.etag);
        }
      }
      return { request: req, status, headers, bodyAsText, readableStreamBody: Readable.from(bytes) };
    },
  });
  return { store, files, calls, current: () => managedBudgetStateSchema.parse(JSON.parse(files.get(key)!.bytes.toString())),
    loseAck: () => { lostAck = true; }, omitDate: () => { noDate = true; }, makePublic: () => { publicContainer = true; },
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
it.each(["missing", "date", "public", "target", "future"])("fails closed on %s ledger evidence without initialization or writes", async reason => {
  const f = fixture();
  if (reason === "missing") f.files.delete(key);
  if (reason === "date") f.omitDate();
  if (reason === "public") f.makePublic();
  if (reason === "target") { const s = f.current(); s.targetBindingHash = hash(99); f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s)); }
  if (reason === "future") f.setDate("Mon, 21 Sep 2026 00:00:00 GMT");
  await expect(f.store.reserve(request())).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it("checks actual worker time at the JST month boundary rather than trusting the submitted month", async () => {
  const f = fixture(), r = request("watch"); await f.store.reserve(r); await f.store.claim(r.operationId, "start");
  f.setDate("Wed, 30 Sep 2026 15:00:01 GMT");
  await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "watch")).rejects.toThrow();
  await expect(f.store.reserve({ ...request(), processingMonth: "2026-09" })).rejects.toThrow();
});
it.each(["intent", "duplicate", "plan", "phase", "future", "extended"])("rejects persisted %s corruption during worker read-back", async reason => {
  const f = fixture(), r = request(); await f.store.reserve(r); await f.store.claim(r.operationId, "stage");
  await f.store.confirmStage(r.operationId, r.requestDigest, hash(9)); await f.store.claim(r.operationId, "start");
  const s = f.current(), o = s.operations[0];
  if (reason === "intent") o.units.jobs = 0;
  if (reason === "duplicate") s.operations.push(o);
  if (reason === "plan") s.plans = [];
  if (reason === "phase") o.stage = "unused";
  if (reason === "future") { o.reservedAt = "2026-09-25T00:00:00.000Z"; o.expiresAt = "2026-09-25T06:00:00.000Z"; }
  if (reason === "extended") o.expiresAt = "2026-09-29T06:00:00.000Z";
  f.files.get(key)!.bytes = Buffer.from(JSON.stringify(s));
  await expect(f.store.verifyClaimed(r.operationId, r.requestDigest, "import")).rejects.toThrow("managed_budget_stopped");
});
