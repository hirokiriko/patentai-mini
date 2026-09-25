import { afterEach, expect, it, vi } from "vitest";
import { managedCloudFixture } from "./managed-cloud.test-support";
import { managedBudgetedWatchFixture } from "./managed-execution-budget.test-support";
import { managedCloudConfigSchema, managedWatchJobTemplate, parseManagedCloudStartConfiguration } from "./managed-cloud-config";
import { managedWatchBudgetRequest, managedImportBudgetRequest } from "./managed-execution-budget";
import { managedCloudImportFixture } from "../../../scripts/managed-koho-cloud.test-support";
import { managedDigest } from "./managed-claims";
import { randomUUID } from "node:crypto";
afterEach(()=>vi.useRealTimers());
it("preserves historical serialized config/template hashes without granting a new start",()=>{
  vi.useFakeTimers({toFake:["Date"]});vi.setSystemTime(new Date("2026-09-23T00:00:00Z"));
  const c=managedCloudFixture();
  expect(managedDigest(managedCloudConfigSchema.parse(c))).toBe("9153bfca25d38d425887bcffe05e05525e770427f6e36de582489ed94627c5dd");
  expect(managedDigest(managedWatchJobTemplate(c,false))).toBe("07e70daa8ac2657d1f1c921b3a5f91ccd30434faa5325df39e05c10cfffdddaf");
  expect(()=>parseManagedCloudStartConfiguration(c)).toThrow();
});
it("derives conservative charges/units and ignores caller-written budget totals",()=>{
  const f=managedBudgetedWatchFixture(),request=(c:unknown)=>managedWatchBudgetRequest(c,f.policy,f.binding,f.pricingDigest,null);
  expect(request(f.config)).toMatchObject({reservationYen:410,units:{jobs:1,minutes:120,starts:1,normal:41,fast:0}});
  expect(request({...f.config,budgetProof:{...f.config.budgetProof,additionalForecastYen:1,monthlyForecastYen:1}})).toEqual(request(f.config));
  expect(managedWatchBudgetRequest(f.config,f.policy,Object.fromEntries(Object.entries(f.binding).reverse()) as typeof f.binding,f.pricingDigest,null)).toEqual(request(f.config));
  expect(request({...f.config,runs:[{...f.config.runs[0],snapshotDigest:"e".repeat(64)}]}).requestDigest).not.toBe(request(f.config).requestDigest);
});
it("refuses a watch policy without reviewed token rates",()=>{
  const f=managedBudgetedWatchFixture();delete f.policy.watchAiRates;
  expect(()=>managedWatchBudgetRequest(f.config,f.policy,f.binding,f.pricingDigest,null)).toThrow();
});
it.each(["code","image","job","db","ai","secret"])("rejects replacement of the reviewed watch %s",field=>{
  const f=managedBudgetedWatchFixture(),c=structuredClone(f.config);
  if(field==="code")c.codeSha="e".repeat(40);
  if(field==="image")c.image=`fictional.azurecr.io/patentai-mini@sha256:${"e".repeat(64)}`;
  if(field==="job")c.jobResourceId=c.jobResourceId.replace("fictional-manual","fictional-other");
  if(field==="db")c.target.user=f.policy.targets.importTarget.user;
  if(field==="ai")c.ai.deployment="fictional-other";
  if(field==="secret")c.secrets.database=f.policy.targets.importDatabaseSecretRef;
  expect(()=>managedWatchBudgetRequest(c,f.policy,f.binding,f.pricingDigest,null)).toThrow();
});
it("binds import intent across ETag sealing while retaining bytes/provenance and Standard scope",async()=>{
  const f=await managedCloudImportFixture(),request=(m:unknown,c:unknown=f.config,profile:string|null=null)=>managedImportBudgetRequest(c,m,f.job,f.policy,f.binding,f.pricingDigest,profile);
  const before=request(f.manifest);f.manifest.packages[0].etag='"sealed"';await f.publish();expect(request(f.manifest)).toEqual(before);
  expect(request({...f.manifest,packages:[{...f.manifest.packages[0],managedSourcesSha256:"d".repeat(64)}]}).requestDigest).not.toBe(before.requestDigest);
  f.manifest.packages[0].byteLength=7*1024**3;f.manifest.maxTotalBytes=8*1024**3;f.manifest.releaseReservation.compressedBytes=96*1024**3;
  expect(request(f.manifest)).toMatchObject({reservationYen:330,units:{jobs:1,minutes:120,packages:1,bytes:7*1024**3}});
  const {releaseReservation,...m}=f.manifest;void releaseReservation;
  const standard={...m,approval:"STANDARD_MANAGED_WATCH_STANDARD_V1" as const,round:100};
  const c={...f.config,approval:standard.approval};
  expect(()=>request(standard,c)).toThrow();expect(request(standard,c,"d".repeat(64))).toMatchObject({scope:"standard",profileDigest:"d".repeat(64)});
});
it("counts canonical packages once and charges every reference Job separately",async()=>{
  const f=await managedCloudImportFixture();f.manifest.archiveOnly=true;f.manifest.packages[0].acquiredAt=new Date(Date.now()-1000).toISOString();
  const request=(m:unknown,c:unknown=f.config)=>managedImportBudgetRequest(c,m,f.job,f.policy,f.binding,f.pricingDigest,null);
  expect(()=>request(f.manifest)).toThrow();f.policy.reservations.archivePackageYen=5;f.policy.reservations.archiveGiBYen=10;
  const archive=request(f.manifest);expect(archive).toMatchObject({reservationYen:15,units:{jobs:0,minutes:0,packages:1,bytes:f.data.length}});
  const id=randomUUID();expect(request({...f.manifest,operationId:id},{...f.config,operationId:id}).requestDigest).toBe(archive.requestDigest);
  const {archiveOnly,...body}=f.manifest;void archiveOnly;
  const pkg={...f.manifest.packages[0],archive:{operationId:f.config.operationId,manifestSha256:"a".repeat(64),receiptSha256:"b".repeat(64)}};
  const batch={...body,operationId:id,packages:[pkg]};
  expect(request(batch,{...f.config,operationId:id})).toMatchObject({reservationYen:f.policy.reservations.importJobYen,units:{jobs:1,minutes:120,packages:0,bytes:0}});
  expect(request({...batch,packages:[{...pkg,expectedDisposition:"reused"}]},{...f.config,operationId:id}).requestDigest).not.toBe(request(batch,{...f.config,operationId:id}).requestDigest);
  expect(()=>request({...batch,packages:[pkg,{...pkg,sha256:"e".repeat(64),archive:undefined}]},{...f.config,operationId:id})).toThrow();
});
