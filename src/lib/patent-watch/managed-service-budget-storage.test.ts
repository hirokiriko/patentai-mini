import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { managedDigest } from "./managed-claims";
import { emptyManagedBudgetUnits, MANAGED_SERVICE_KEY, managedBudgetProfileSchema, managedBudgetStateSchema, settleManagedBudget, setManagedMonthPlan } from "./managed-service-budget";
import { MANAGED_BUDGET_PREFIX, ManagedServiceBudgetStorage } from "./managed-service-budget-storage";
import { managedAdministrationReviewSchema, type ManagedAdministrationReview, type ManagedSettlementReview, type ManagedReleaseStep } from "./managed-budget-evidence";
import { managedBudgetedWatchFixture } from "./managed-execution-budget.test-support";
import { managedCloudFixture } from "./managed-cloud.test-support";
import type { ManagedBudgetBinding } from "./managed-budget-contract";
import { managedCloudImportFixture } from "../../../scripts/managed-koho-cloud.test-support";
import { archivePackageIdentity, archiveReceiptName } from "../koho-import/managed-archive";
import { cloudManifestName, cloudSourceName, sha256 } from "../koho-import/cloud-config";
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();});

const hash = (n: number) => n.toString(16).padStart(64, "0"), key = `${MANAGED_BUDGET_PREFIX}state.json`;
const openedKey = `${MANAGED_BUDGET_PREFIX}opened.json`, openingIntentKey = `${MANAGED_BUDGET_PREFIX}opening-intent.json`;
function request(kind: "watch" | "import" = "import") { return { operationId: randomUUID(), requestDigest: managedDigest(randomUUID()),
  scope: "release", kind, profileDigest: null, pricingDigest: hash(4), cases: [1], reservationYen: 600,
  units: { ...emptyManagedBudgetUnits(), jobs: 1, minutes: 120, ...(kind === "watch" ? { starts: 1, normal: 41 } : { packages: 1, bytes: 1024 }) } }; }
function fixture(binding:ManagedBudgetBinding = { storageAccount: "fictional", container: "private-import", targetBindingHash: hash(1), ownerBindingHash: hash(8) }) {
  const initial = managedBudgetStateSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: binding.targetBindingHash,
    activeProfileDigest: null, cases: [], lastTrustedAt: "2026-09-22T00:00:00.000Z", releaseTailYen: 20_000,
    legacyUnknownYen: 2000, openingEvidenceDigest: hash(2), administration: [{ sequence: 1, digest: hash(2) }], plans: [{ month: "2026-09", baseYen: 10_000,
      pools: { remaining: 1000, storage: 1000, recovery: 1000 }, pricingDigest: hash(4), evidenceDigests: [hash(3)] }], operations: [] });
  const files = new Map([[key, { bytes: Buffer.from(JSON.stringify(initial)), etag: '"v1"' }]]), calls: string[] = [];
  files.set(openedKey, { bytes: Buffer.from(JSON.stringify({ schema: 1, reviewDigest: hash(2), initialStateDigest: hash(20) })), etag: '"opened"' });
  const created = new Map<string, string>();
  let counter = 1, lostAck: string | null = null, noDate = false, publicContainer = false, date = "Wed, 23 Sep 2026 00:00:00 GMT";
  let rejectStateWrite = false;
  let onRead:(name:string)=>void=()=>{};
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
        if(req.method==="GET")onRead(name);
        const stored = files.get(name);
        if (!stored) { status = 404; headers.set("x-ms-error-code", "BlobNotFound"); headers.set("content-type", "application/xml"); bodyAsText = req.method === "HEAD" ? "" : "<Error><Code>BlobNotFound</Code></Error>"; }
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
  return { store, files, calls, created, binding, current: () => managedBudgetStateSchema.parse(JSON.parse(files.get(key)!.bytes.toString())),
    loseAck: (name = key) => { lostAck = name; }, restoreAck: () => { lostAck = null; },
    rejectStateWrite: (value: boolean) => { rejectStateWrite = value; },
    onRead:(hook:(name:string)=>void)=>{onRead=hook;},
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

function executionFixture(){
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  const b=managedBudgetedWatchFixture(managedCloudFixture()),f=fixture(b.binding);
  const s=f.current();s.plans[0].pricingDigest=b.pricingDigest;f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));
  f.files.set(`${MANAGED_BUDGET_PREFIX}evidence/${b.pricingDigest}.json`,{bytes:Buffer.from(JSON.stringify(b.policy)),etag:'"policy"'});
  return{...f,...b};
}
function artifactFixture(kind: "delivery" | "backup" | "recovery") {
  const f=executionFixture(),id=randomUUID();
  const intent=kind==="delivery"?{kind,caseId:1,deliveryId:id,period:{from:"2026-07-26",to:"2026-08-25"},
    distributionTableSha256:hash(51),reason:"initial",deliveredOn:null}:kind==="backup"?{kind,caseId:1,backupId:id}:
    {kind,caseId:1,backupId:randomUUID(),recoveryOperationId:id,sha256:hash(52),bytes:100};
  const context={approval:f.config.approval,target:f.config.target,codeSha:f.config.codeSha,
    containerUrl:"https://fictional.blob.core.windows.net/private-artifacts"};
  return {...f,intent,context,admit:(value:unknown=intent,c:unknown=context,signal=AbortSignal.timeout(90_000))=>f.store.withDeadline(signal).admitArtifact(value,c)};
}
it.each(["delivery","backup","recovery"] as const)("atomically admits one %s with fixed prices and no watch/import units",async kind=>{
  const f=artifactFixture(kind);await f.admit();
  expect(f.current().operations).toHaveLength(1);
  expect(f.current().operations[0]).toMatchObject({kind,start:"claimed",stage:"unused",actualYen:null,
    reservationYen:kind==="recovery"?500:50,units:emptyManagedBudgetUnits()});
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(1);
  await expect(f.admit()).rejects.toThrow();await expect(f.admit({...f.intent,caseId:2})).rejects.toThrow();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(1);
});
it("retains an artifact claim after a lost CAS ACK and denies replay",async()=>{
  const f=artifactFixture("backup");f.loseAck();await expect(f.admit()).rejects.toThrow();
  expect(f.current().operations[0]).toMatchObject({start:"claimed",actualYen:null,reservationYen:50});
  f.restoreAck();await expect(f.admit()).rejects.toThrow();expect(f.current().operations).toHaveLength(1);
});
it.each(["target","storage","code","price","recovery-id"])("rejects changed artifact %s before a write",async field=>{
  const f=artifactFixture("recovery"),c=structuredClone(f.context),value={...f.intent};
  if(field==="target")c.target.user="wrong";
  if(field==="storage")c.containerUrl="https://fictional.blob.core.windows.net/private-import";
  if(field==="code")c.codeSha="f".repeat(40);
  if(field==="price")Object.assign(value,{reservationYen:0});
  if(field==="recovery-id")Object.assign(value,{recoveryOperationId:value.backupId});
  await expect(f.admit(value,c)).rejects.toThrow();expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it.each([["delivery","Wed, 30 Sep 2026 14:57:09 GMT"],["backup","Wed, 30 Sep 2026 14:53:39 GMT"]] as const)("rejects %s at the exact month-end safety boundary",async(kind,date)=>{
  const f=artifactFixture(kind);f.setDate(date);await expect(f.admit()).rejects.toThrow();expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it("honors the parent's abort during artifact policy IO, without a later CAS",async()=>{
  const f=artifactFixture("delivery"),controller=new AbortController();
  f.onRead(name=>{if(name.includes("/evidence/"))controller.abort();});
  await expect(f.admit(f.intent,f.context,controller.signal)).rejects.toThrow();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it("allows only one concurrent artifact CAS",async()=>{
  const f=artifactFixture("backup");f.raceReads();
  const results=await Promise.allSettled([f.admit(),f.admit()]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.current().operations).toHaveLength(1);
});
it("derives a watch reservation from reviewed policy, claims once, and verifies the original execution",async()=>{
  const f=executionFixture(),legacy=managedCloudFixture();
  const c=await f.store.prepareWatch(legacy);expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
  expect(await f.store.reserveWatch(c)).toEqual({created:true});
  expect(f.current().operations[0]).toMatchObject({reservationYen:410,units:{jobs:1,minutes:120,starts:1,normal:41},pricingDigest:f.pricingDigest});
  await f.store.claimWatch(c);await f.store.markUnknown(c.operationId);
  expect(await f.store.verifyWatch(c)).toMatchObject({processingMonth:"2026-09",expiresAt:c.expiresAt,
    aiBudget:{inputYenPerMillion:500,outputYenPerMillion:3000,maximumYen:400}});
  await expect(f.store.claimWatch(c)).rejects.toThrow();
  expect(await f.store.reserveWatch(c)).toEqual({created:false});
  expect(f.current().operations).toHaveLength(1);
  await expect(f.store.verifyWatch({...c,runs:[{...c.runs[0],snapshotDigest:hash(45)}]})).rejects.toThrow();
});
it.each(["changed-policy","raw-policy","missing-policy","changed-binding","expired-policy"])("blocks %s before reserving business costs",async reason=>{
  const f=executionFixture(),c=await f.store.prepareWatch(managedCloudFixture());
  if(reason==="changed-policy"){const s=f.current();s.plans[0].pricingDigest=hash(11);f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));}
  if(reason==="raw-policy")f.files.get(`${MANAGED_BUDGET_PREFIX}evidence/${f.pricingDigest}.json`)!.bytes=Buffer.from(JSON.stringify({...f.policy,reservations:{...f.policy.reservations,watchRunYen:1}}));
  if(reason==="missing-policy")f.files.delete(`${MANAGED_BUDGET_PREFIX}evidence/${f.pricingDigest}.json`);
  if(reason==="changed-binding")c.budgetBinding.ownerBindingHash=hash(77);
  if(reason==="expired-policy")f.setDate("Wed, 30 Sep 2026 14:30:00 GMT");
  await expect(f.store.reserveWatch(c)).rejects.toThrow("managed_budget_stopped");
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it("rechecks state and Blob Date after pricing IO before admitting a reservation",async()=>{
  const f=executionFixture(),c=await f.store.prepareWatch(managedCloudFixture());let changed=false;
  f.onRead(name=>{if(!changed&&name.endsWith(`${f.pricingDigest}.json`)){changed=true;f.files.get(key)!.etag='"competing-update"';}});
  await expect(f.store.reserveWatch(c)).rejects.toThrow();expect(f.current().operations).toEqual([]);
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it("retains an original Standard profile for an already claimed worker after profile and price revision",async()=>{
  const f=executionFixture();
  const p=managedBudgetProfileSchema.parse({schema:1,serviceKey:MANAGED_SERVICE_KEY,targetBindingHash:f.binding.targetBindingHash,ownerBindingHash:f.binding.ownerBindingHash,
    companyKey:"FICTIONAL_COMPANY",cases:[7],monthlyCapYen:30_000,monthlyUnits:{...emptyManagedBudgetUnits(),jobs:2,minutes:240,starts:2,normal:82},
    pricingDigest:f.pricingDigest,measurementDigest:f.policy.measurementDigest,goEvidenceDigest:hash(76)});
  const a=managedDigest(p),s=f.current();s.activeProfileDigest=a;s.cases=[7];f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));
  f.files.set(`${MANAGED_BUDGET_PREFIX}profiles/${a}.json`,{bytes:Buffer.from(JSON.stringify(p)),etag:'"profile-a"'});
  const c=await f.store.prepareWatch({...managedCloudFixture(),approval:"STANDARD_MANAGED_WATCH_STANDARD_V1"});
  await f.store.reserveWatch(c);await f.store.claimWatch(c);
  const revised=f.current();revised.activeProfileDigest=hash(78);revised.plans[0].pricingDigest=hash(79);f.files.get(key)!.bytes=Buffer.from(JSON.stringify(revised));
  expect(await f.store.verifyWatch(c)).toMatchObject({processingMonth:"2026-09"});
  await expect(f.store.claimWatch(c)).rejects.toThrow();
  f.files.delete(`${MANAGED_BUDGET_PREFIX}profiles/${a}.json`);
  await expect(f.store.verifyWatch(c)).rejects.toThrow();
});
it("rechecks expiry and operation status after policy IO in the Worker",async()=>{
  const f=executionFixture(),c=await f.store.prepareWatch(managedCloudFixture());await f.store.reserveWatch(c);await f.store.claimWatch(c);
  f.onRead(name=>{if(name.endsWith(`${f.pricingDigest}.json`))f.setDate("Wed, 23 Sep 2026 02:00:00 GMT");});
  await expect(f.store.verifyWatch(c)).rejects.toThrow();
});
it("refuses to reserve a watch whose execution deadline cannot contain the job",async()=>{
  const f=executionFixture(),c=await f.store.prepareWatch({...managedCloudFixture(),expiresAt:"2026-09-23T01:00:00.000Z"});
  await expect(f.store.reserveWatch(c)).rejects.toThrow();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual([]);
});
it.each(["stage","start"] as const)("refuses an import %s claim when only its manifest deadline is too near",async phase=>{
  vi.spyOn(Date,"now").mockReturnValue(Date.parse("2026-09-23T00:00:00Z"));
  const b=await managedCloudImportFixture(),f=fixture(b.binding),s=f.current();s.plans[0].pricingDigest=b.pricingDigest;
  f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));f.files.set(`${MANAGED_BUDGET_PREFIX}evidence/${b.pricingDigest}.json`,{bytes:Buffer.from(JSON.stringify(b.policy)),etag:'"policy"'});
  const c=await f.store.prepareImport(b.config,b.manifest,b.job);await f.store.reserveImport(c,b.manifest,b.job);
  if(phase==="start"){await f.store.claimImport(c,b.manifest,b.job,"stage");await f.store.confirmImport(c,b.manifest,b.job);}
  f.setDate(phase==="stage"?"Wed, 23 Sep 2026 02:10:00 GMT":"Wed, 23 Sep 2026 01:00:00 GMT");
  const writes=f.calls.filter(c=>c.startsWith("PUT:"));let effects=0;
  await expect(f.store.claimImport(c,b.manifest,b.job,phase).then(()=>{effects++;})).rejects.toThrow();
  expect(effects).toBe(0);expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual(writes);
  expect(f.current().operations[0][phase]).toBe("ready");
});
it("shares the reviewed import reservation across ETag sealing, stage confirmation, start and worker read-back",async()=>{
  vi.spyOn(Date,"now").mockReturnValue(Date.parse("2026-09-23T00:00:00Z"));
  const b=await managedCloudImportFixture(),f=fixture(b.binding),s=f.current();s.plans[0].pricingDigest=b.pricingDigest;
  f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));f.files.set(`${MANAGED_BUDGET_PREFIX}evidence/${b.pricingDigest}.json`,{bytes:Buffer.from(JSON.stringify(b.policy)),etag:'"policy"'});
  const c=await f.store.prepareImport(b.config,b.manifest,b.job);expect(await f.store.reserveImport(c,b.manifest,b.job)).toEqual({created:true});
  await f.store.claimImport(c,b.manifest,b.job,"stage");await expect(f.store.claimImport(c,b.manifest,b.job,"start")).rejects.toThrow();
  b.manifest.packages[0].etag='"sealed"';await b.publish();const sealed={...c,manifest:b.config.manifest};
  await f.store.confirmImport(sealed,b.manifest,b.job);await f.store.confirmImport(sealed,b.manifest,b.job);
  await f.store.claimImport(sealed,b.manifest,b.job,"start");
  expect(await f.store.verifyImport(sealed,b.manifest,b.job)).toMatchObject({processingMonth:"2026-09"});
  expect(f.current().operations).toHaveLength(1);expect(f.current().operations[0]).toMatchObject({reservationYen:90,stage:"done",start:"claimed",units:{packages:1,bytes:b.data.length}});
  await expect(f.store.claimImport(sealed,b.manifest,b.job,"start")).rejects.toThrow();
  await expect(f.store.verifyImport(sealed,{...b.manifest,packages:[{...b.manifest.packages[0],managedSourcesSha256:hash(70)}]},b.job)).rejects.toThrow();
});
async function archivedExecutionFixture(){
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  const b=await managedCloudImportFixture(),f=fixture(b.binding);
  b.policy.reservations.archivePackageYen=5;b.policy.reservations.archiveGiBYen=10;
  const policyBytes=Buffer.from(JSON.stringify(b.policy)),pricingDigest=sha256(policyBytes),state=f.current();state.plans[0].pricingDigest=pricingDigest;
  f.files.get(key)!.bytes=Buffer.from(JSON.stringify(state));f.files.set(`${MANAGED_BUDGET_PREFIX}evidence/${pricingDigest}.json`,{bytes:policyBytes,etag:'"archivepolicy"'});
  b.manifest.archiveOnly=true;b.manifest.packages[0].acquiredAt="2026-09-22T23:59:00.000Z";delete b.config.serviceBudget;
  const config=await f.store.prepareImport(b.config,b.manifest,b.job);
  await f.store.reserveImport(config,b.manifest,b.job);await f.store.claimImport(config,b.manifest,b.job,"stage");
  const bytes=Buffer.from(JSON.stringify(b.manifest)),sealed={...config,manifest:{byteLength:bytes.length,sha256:sha256(bytes),etag:'"archivemanifest"'}};
  const pkg=b.manifest.packages[0],identity=archivePackageIdentity(pkg),receipt=Buffer.from(JSON.stringify({schema:1,operationId:sealed.operationId,
    requestDigest:sealed.serviceBudget.requestDigest,identityDigest:managedDigest(identity),identity,blobName:cloudSourceName(pkg.sha256),etag:pkg.etag,
    verifiedAt:"2026-09-23T00:00:00.000Z"}));
  f.files.set(cloudManifestName(sealed),{bytes,etag:sealed.manifest.etag});f.files.set(archiveReceiptName(sealed.operationId),{bytes:receipt,etag:'"archivereceipt"'});
  f.files.set(cloudSourceName(pkg.sha256),{bytes:Buffer.from(b.data),etag:pkg.etag});
  const receiptSha256=sha256(receipt),archive={operationId:sealed.operationId,manifestSha256:sealed.manifest.sha256,receiptSha256};
  const id=randomUUID(),{archiveOnly,...body}=b.manifest;void archiveOnly;
  const manifest={...body,operationId:id,packages:[{...pkg,expectedDisposition:"reused" as const,archive}]};
  const {serviceBudget,...business}=sealed;void serviceBudget;const batchConfig={...business,operationId:id};
  return{...f,b,sealed,receiptSha256,manifest,batchConfig,pricingDigest};
}
it("requires confirmed original archive accounting before cleanup or a zero-package Job reservation",async()=>{
  const f=await archivedExecutionFixture();
  await expect(f.store.verifyArchiveRelease(f.sealed,f.b.manifest,f.receiptSha256)).rejects.toThrow();
  await expect(f.store.prepareImport(f.batchConfig,f.manifest,f.b.job)).rejects.toThrow();
  await f.store.confirmImport(f.sealed,f.b.manifest,f.b.job);
  await f.store.verifyArchiveRelease(f.sealed,f.b.manifest,f.receiptSha256);
  await expect(f.store.claimImport(f.sealed,f.b.manifest,f.b.job,"start")).rejects.toThrow();
  await expect(f.store.verifyImport(f.sealed,f.b.manifest,f.b.job)).rejects.toThrow();
  const config=await f.store.prepareImport(f.batchConfig,f.manifest,f.b.job);await f.store.reserveImport(config,f.manifest,f.b.job);
  await f.store.claimImport(config,f.manifest,f.b.job,"stage");await f.store.confirmImport(config,f.manifest,f.b.job);await f.store.claimImport(config,f.manifest,f.b.job,"start");
  await f.store.verifyImport(config,f.manifest,f.b.job);
  expect(f.current().operations.map(o=>({yen:o.reservationYen,units:o.units}))).toMatchObject([
    {yen:15,units:{jobs:0,minutes:0,packages:1,bytes:f.b.data.length}},
    {yen:f.b.policy.reservations.importJobYen,units:{jobs:1,minutes:120,packages:0,bytes:0}}]);
  const id=randomUUID();const duplicate=await f.store.prepareImport({...f.b.config,operationId:id},{...f.b.manifest,operationId:id},f.b.job);
  await expect(f.store.reserveImport(duplicate,{...f.b.manifest,operationId:id},f.b.job)).rejects.toThrow();
  expect(f.current().operations).toHaveLength(2);
});
it.each(["receipt","source-etag","source-size","source-identity","manifest","ledger"])("rejects changed archive %s before Job reservation",async change=>{
  const f=await archivedExecutionFixture();await f.store.confirmImport(f.sealed,f.b.manifest,f.b.job);
  const pkg=f.manifest.packages[0];
  if(change==="receipt")f.files.get(archiveReceiptName(f.sealed.operationId))!.bytes=Buffer.from("{}");
  if(change==="manifest")f.files.get(cloudManifestName(f.sealed))!.bytes=Buffer.from("{}");
  if(change==="source-etag")f.files.get(cloudSourceName(pkg.sha256))!.etag='"altered"';
  if(change==="source-size")f.files.get(cloudSourceName(pkg.sha256))!.bytes=Buffer.from("altered");
  if(change==="source-identity")pkg.acquiredAt="2026-09-22T23:58:00.000Z";
  if(change==="ledger"){const state=f.current();state.operations=[];f.files.get(key)!.bytes=Buffer.from(JSON.stringify(state));}
  const writes=f.calls.filter(c=>c.startsWith("PUT:"));await expect(f.store.prepareImport(f.batchConfig,f.manifest,f.b.job)).rejects.toThrow();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual(writes);
});
it("uses historical release archives in a current Standard Job without renewing or clearing the original reservation",async()=>{
  const f=await archivedExecutionFixture();await f.store.confirmImport(f.sealed,f.b.manifest,f.b.job);
  const profile=managedBudgetProfileSchema.parse({schema:1,serviceKey:MANAGED_SERVICE_KEY,targetBindingHash:f.binding.targetBindingHash,ownerBindingHash:f.binding.ownerBindingHash,
    companyKey:"FICTIONAL_COMPANY",cases:[],monthlyCapYen:30_000,monthlyUnits:{...emptyManagedBudgetUnits(),jobs:2,minutes:240,packages:1,bytes:f.b.data.length},
    pricingDigest:f.pricingDigest,measurementDigest:f.b.policy.measurementDigest,goEvidenceDigest:hash(76)});
  const state=f.current(),prior=structuredClone(state.operations[0]),profileDigest=managedDigest(profile);state.activeProfileDigest=profileDigest;
  f.files.get(key)!.bytes=Buffer.from(JSON.stringify(state));f.files.set(`${MANAGED_BUDGET_PREFIX}profiles/${profileDigest}.json`,{bytes:Buffer.from(JSON.stringify(profile)),etag:'"profile"'});
  f.setDate("Thu, 24 Sep 2026 00:00:00 GMT");vi.setSystemTime(new Date("2026-09-24T00:00:00Z"));
  const {releaseReservation,...body}=f.manifest;void releaseReservation;
  const manifest={...body,approval:"STANDARD_MANAGED_WATCH_STANDARD_V1" as const,expiresAt:"2026-09-24T03:00:00.000Z"};
  const config=await f.store.prepareImport({...f.batchConfig,approval:manifest.approval},manifest,f.b.job);
  await f.store.reserveImport(config,manifest,f.b.job);expect(f.current().operations[0]).toEqual(prior);
  await f.store.verifyArchiveRelease(f.sealed,f.b.manifest,f.receiptSha256);
});
it("retains canonical stage proof after more than 64 reviewed accounting observations",async()=>{
  const f=await archivedExecutionFixture();await f.store.confirmImport(f.sealed,f.b.manifest,f.b.job);
  let state=f.current();const original=state.operations[0],clock={blobDate:new Date("2026-09-23T00:00:00Z"),maximumActionMs:60_000};
  for(let i=1;i<=65;i++)state=settleManagedBudget(state,{operationId:original.operationId,requestDigest:original.requestDigest,sequence:i,evidenceDigest:hash(1000+i),knownUnits:{},observedYen:1},clock);
  state=setManagedMonthPlan(state,{...state.plans[0],evidenceDigest:hash(2000),releaseTailYen:state.releaseTailYen,reviewedOperationIds:[original.operationId]},clock);
  expect(state.operations[0].evidenceDigests).not.toContain(f.sealed.manifest.sha256);expect(state.operations[0].stageDigest).toBe(f.sealed.manifest.sha256);
  f.files.get(key)!.bytes=Buffer.from(JSON.stringify(state));await f.store.verifyArchiveRelease(f.sealed,f.b.manifest,f.receiptSha256);
  const config=await f.store.prepareImport(f.batchConfig,f.manifest,f.b.job);await f.store.reserveImport(config,f.manifest,f.b.job);
  expect(f.current().operations[0].units).toEqual(original.units);expect(f.current().operations[0].reservationYen).toBe(original.reservationYen);
});

function adminReviewed(f: ReturnType<typeof fixture>, action?: ManagedAdministrationReview["action"], changes: Partial<ManagedAdministrationReview> = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), der = publicKey.export({ format: "der", type: "spki" });
  const pins = { publicKeySpkiBase64: der.toString("base64"), publicKeySha256: createHash("sha256").update(der).digest("hex"),
    ownerBindingHash: f.binding.ownerBindingHash, targetBindingHash: f.binding.targetBindingHash, productionGoDigest: undefined as string | undefined };
  const fact = Buffer.from(JSON.stringify({ schema: 1, kind: "FICTIONAL_REVIEWED_ADMINISTRATION" }));
  const factDigest = createHash("sha256").update(fact).digest("hex"), factKey = `${MANAGED_BUDGET_PREFIX}evidence/${factDigest}.json`;
  f.files.set(factKey, { bytes: fact, etag: '"fact"' });
  const current = f.current();
  action ??= { kind: "month", processingMonth: "2026-09", baseYen: 10_001,
    pools: { remaining: 1000, storage: 1000, recovery: 1000 }, pricingDigest: factDigest, releaseTailYen: current.releaseTailYen, reviewedOperationIds: [] };
  if (action.kind === "open") action = { ...action, state: { ...action.state, openingEvidenceDigest: factDigest,
    plans: action.state.plans.map(p => ({ ...p, pricingDigest: factDigest })) } };
  if (action.kind === "month") action = { ...action, pricingDigest: factDigest };
  if (action.kind === "release-start") action = { ...action, step: { ...action.step, preflightDigest: factDigest } };
  if (action.kind === "activate") {
    const p = managedBudgetProfileSchema.parse({ schema: 1, serviceKey: MANAGED_SERVICE_KEY, targetBindingHash: hash(1), ownerBindingHash: hash(8),
      companyKey: "FICTIONAL_COMPANY", cases: [1], monthlyCapYen: 30_000,
      monthlyUnits: { ...emptyManagedBudgetUnits(), jobs: 2, minutes: 240, starts: 2, normal: 82 },
      pricingDigest: factDigest, measurementDigest: factDigest, goEvidenceDigest: factDigest });
    action = { kind: "activate", profileDigest: managedDigest(p), pricingDigest: factDigest, measurementDigest: factDigest, goEvidenceDigest: factDigest };
    f.files.set(`${MANAGED_BUDGET_PREFIX}profiles/${action.profileDigest}.json`, { bytes: Buffer.from(JSON.stringify(p)), etag: '"profile"' });
    pins.productionGoDigest = factDigest;
  }
  const sources = [{ digest: factDigest, bytes: fact.length }];
  if (action.kind === "release-start") sources.push({ digest: action.step.pricingDigest, bytes: f.files.get(`${MANAGED_BUDGET_PREFIX}evidence/${action.step.pricingDigest}.json`)!.bytes.length });
  const review = managedAdministrationReviewSchema.parse({ schema: 1, purpose: "MANAGED_WATCH_ADMINISTRATION_REVIEW_V1", targetBindingHash: pins.targetBindingHash, ownerBindingHash: pins.ownerBindingHash,
    sequence: action.kind === "open" ? 1 : current.administration.length + 1,
    previousReviewDigest: action.kind === "open" ? null : current.administration.at(-1)?.digest ?? null,
    expectedStateDigest: action.kind === "open" ? null : managedDigest(current),
    issuedAt: action.kind === "release-start" ? "2026-09-23T00:00:00Z" : "2026-09-22T00:00:00Z",
    validUntil: action.kind === "release-start" ? "2026-09-23T00:15:00Z" : "2026-09-25T00:00:00Z", sources, action, ...changes });
  const envelope = { review, signature: sign(null, Buffer.from(managedDigest(review), "hex"), privateKey).toString("base64") };
  const digest = managedDigest(envelope);
  f.files.set(`${MANAGED_BUDGET_PREFIX}administration-reviews/${digest}.json`, { bytes: Buffer.from(JSON.stringify(envelope)), etag: '"review"' });
  return { digest, pins, envelope, factKey };
}
function releaseStep(f:ReturnType<typeof executionFixture>,kind:ManagedReleaseStep["kind"]="validation"):ManagedReleaseStep {
  return {issue:129,repository:"hirokiriko/patentai-mini",operationId:randomUUID(),kind,
    trigger:kind==="validation"?"pr-push":"squash-merge",prNumber:130,
    targetRef:kind==="validation"?"refs/heads/codex/issue-129-test":"refs/heads/main",
    remoteBeforeSha:"b".repeat(40),headSha:"a".repeat(40),baseSha:"b".repeat(40),treeSha:"c".repeat(40),
    ciWorkflowSha256:hash(40),deployWorkflowSha256:hash(41),preflightDigest:hash(42),pricingDigest:f.pricingDigest,reservationYen:100};
}
it.each(["validation","forward","rollback"] as const)("admits a signed Local %s step only from a new atomic CAS ACK",async kind=>{
  const f=executionFixture(),step=releaseStep(f,kind),p=adminReviewed(f,{kind:"release-start",step});
  expect(await f.store.applyReviewedAdministration(p.digest,p.pins,true)).toEqual({status:"not_applied"});
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(0);
  expect(await f.store.applyReviewedAdministration(p.digest,p.pins)).toMatchObject({status:"admitted",operationId:step.operationId,
    headSha:step.headSha,baseSha:step.baseSha,remoteBeforeSha:step.remoteBeforeSha,executeBefore:"2026-09-23T00:01:00.000Z"});
  expect(f.current().operations).toHaveLength(1);expect(f.current().administration).toHaveLength(2);
  expect(f.current().operations[0]).toMatchObject({kind:kind==="validation"?"validation":"deploy",start:"claimed",actualYen:null,
    units:{...emptyManagedBudgetUnits(),...(kind==="validation"?{}:{[kind]:1})}});
  expect(await f.store.applyReviewedAdministration(p.digest,p.pins)).toEqual({status:"already_applied"});
  expect(await f.store.applyReviewedAdministration(p.digest,p.pins,true)).toEqual({status:"already_applied"});
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(1);
});
it("retains a release claim with a lost ACK but never reconstructs its permit",async()=>{
  const f=executionFixture(),step=releaseStep(f,"forward"),p=adminReviewed(f,{kind:"release-start",step});f.loseAck();
  await expect(f.store.applyReviewedAdministration(p.digest,p.pins)).rejects.toThrow();f.restoreAck();
  expect(f.current().operations[0]).toMatchObject({start:"claimed",reservationYen:100,units:{forward:1}});
  expect(await f.store.applyReviewedAdministration(p.digest,p.pins,true)).toEqual({status:"already_applied"});
  const retry=adminReviewed(f,{kind:"release-start",step});await expect(f.store.applyReviewedAdministration(retry.digest,retry.pins)).rejects.toThrow();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(1);
});
it.each(["expired","long-signature","changed-price-bytes","budget-exhausted","stale-state"])("rejects a %s release review before the atomic admission",async reason=>{
  const f=executionFixture(),step=releaseStep(f);
  if(reason==="budget-exhausted"){const s=f.current();s.plans[0].pools.remaining=0;f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));}
  const p=adminReviewed(f,{kind:"release-start",step},reason==="long-signature"?{validUntil:"2026-09-24T00:00:00Z"}:{});
  if(reason==="expired")f.setDate("Wed, 23 Sep 2026 00:15:00 GMT");
  if(reason==="changed-price-bytes")f.files.get(`${MANAGED_BUDGET_PREFIX}evidence/${f.pricingDigest}.json`)!.bytes=Buffer.from("{}");
  if(reason==="stale-state"){
    const s=f.current();s.releaseTailYen-=1;
    f.files.get(key)!.bytes=Buffer.from(JSON.stringify(s));
  }
  await expect(f.store.applyReviewedAdministration(p.digest,p.pins)).rejects.toThrow();expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(0);
});
it("admits only one competing signed release step against the reviewed state",async()=>{
  const f=executionFixture(),a=adminReviewed(f,{kind:"release-start",step:releaseStep(f)}),b=adminReviewed(f,{kind:"release-start",step:releaseStep(f)});
  f.raceReads();const results=await Promise.allSettled([f.store.applyReviewedAdministration(a.digest,a.pins),f.store.applyReviewedAdministration(b.digest,b.pins)]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.current().operations).toHaveLength(1);expect(f.current().administration).toHaveLength(2);
});
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
  const r = { ...request("watch"), pricingDigest: f.current().plans[0].pricingDigest };
  await f.store.reserve(r); await f.store.claim(r.operationId, "start"); await f.store.markUnknown(r.operationId);
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
    baseYen: 10_000, pools: { remaining: 1000, storage: 1000, recovery: 1000 }, pricingDigest: hash(4), releaseTailYen: 20_000, reviewedOperationIds: [] };
  const p = adminReviewed(f, action, changes);
  if (reason === "fact") f.files.get(p.factKey)!.bytes = Buffer.from("{}");
  if (reason === "expired") f.setDate("Sat, 26 Sep 2026 00:00:00 GMT");
  await expect(f.store.applyReviewedAdministration(p.digest, p.pins)).rejects.toThrow();
  expect(f.calls.filter(c => c.startsWith("PUT:"))).toHaveLength(0);
});
it("activates only a signed profile whose GO digest is independently installed", async () => {
  const f = fixture(), plan = adminReviewed(f); await f.store.applyReviewedAdministration(plan.digest, plan.pins);
  const p = adminReviewed(f, { kind: "activate", profileDigest: hash(1), goEvidenceDigest: hash(1), measurementDigest: hash(1), pricingDigest: hash(1) }), before = f.calls.length;
  await expect(f.store.applyReviewedAdministration(p.digest, { ...p.pins, productionGoDigest: undefined })).rejects.toThrow();
  expect(f.calls.slice(before).filter(c => c.startsWith("PUT:"))).toHaveLength(0);
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
