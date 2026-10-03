import { link, lstat, mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { afterEach, expect, it, vi } from "vitest";
import { managedCloudImportFixture } from "./managed-koho-cloud.test-support";
import { operateManagedKoho, type ManagedKohoBudget } from "./managed-koho-operator";
import { cloudManifestName, cloudReceiptPrefix, cloudSourceName, sha256 } from "../src/lib/koho-import/cloud-config";
import { managedImportBudgetRequest } from "../src/lib/patent-watch/managed-execution-budget";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
import { allocateManagedDownload, completeManagedDownload, copyManagedTransfer, managedTransferStatus, releaseManagedTransfer } from "./managed-koho-transfer";
import { copyManualSource } from "../src/lib/koho-import/manual-cli-source";
import * as manualSource from "../src/lib/koho-import/manual-cli-source";
import { archivePackageIdentity, archiveReceiptName, confirmArchiveReceipt } from "../src/lib/koho-import/managed-archive";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
import * as tailOperator from "./managed-koho-tail";
const temporary:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture(archiveOnly=false){
  const f=await managedCloudImportFixture(),path=await mkdtemp(join(tmpdir(),"managed-operator-test-"));temporary.push(path);
  if(archiveOnly){f.manifest.archiveOnly=true;f.manifest.packages[0].acquiredAt=new Date(Date.now()-60_000).toISOString();
    f.policy.reservations.archivePackageYen=5;f.policy.reservations.archiveGiBYen=10;
    f.request=managedImportBudgetRequest(f.config,f.manifest,f.job,f.policy,f.binding,f.pricingDigest,null);f.config.serviceBudget!.requestDigest=f.request.requestDigest;}
  const sourcePath=join(path,"fictional.zip");await writeFile(sourcePath,f.data);
  const files=new Map<string,Buffer>([[cloudSourceName(f.manifest.packages[0].sha256),f.data]]),calls:string[]=[];
  let loseAck="",expireAfter="",headFailure="",creationAgeMs=30_000;
  const pipeline=newPipeline(new AnonymousCredential(),{retryOptions:{maxTries:1},httpClient:{async sendRequest(request){
    const url=new URL(request.url),name=url.pathname.slice(`/${f.config.container}/`.length),headers=request.headers.clone();
    for(const key of headers.headerNames())headers.remove(key);
    headers.set("x-ms-request-id","fictional");headers.set("x-ms-version","2025-11-05");headers.set("etag",'"sealed"');calls.push(`${request.method}:${name}`);
    headers.set("last-modified",new Date(Date.now()-30_000).toUTCString());
    headers.set("x-ms-creation-time",new Date(Date.now()-creationAgeMs).toUTCString());
    let status=200,data=Buffer.alloc(0),bodyAsText:string|undefined;
    if(url.searchParams.get("restype")==="container"){}
    else if(request.method==="HEAD"&&name===cloudSourceName(f.manifest.packages[0].sha256)&&headFailure){
      if(headFailure==="timeout")throw Error("FICTIONAL_TIMEOUT");
      status=headFailure==="AuthorizationPermissionMismatch"?403:404;
      if(headFailure!=="bare404")headers.set("x-ms-error-code",headFailure);
      bodyAsText="";
    }
    else if(request.method==="PUT"){
      expect(request.headers.get("if-none-match")).toBe("*");
      if(files.has(name))status=412;
      else{const body=typeof request.body==="function"?request.body():request.body;
        if(body&&typeof body==="object"&&Symbol.asyncIterator in body){const parts:Buffer[]=[];for await(const chunk of body as AsyncIterable<Uint8Array>)parts.push(Buffer.from(chunk));files.set(name,Buffer.concat(parts));}
        else files.set(name,Buffer.from(body as Uint8Array));status=201;}
      if(name===expireAfter)vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
      if(name===loseAck)throw Error("FICTIONAL_LOST_ACK");
    } else if(!files.has(name)){
      status=404;headers.set("x-ms-error-code","BlobNotFound");headers.set("content-type","application/xml");bodyAsText=request.method==="HEAD"?"":'<Error><Code>BlobNotFound</Code></Error>';
    } else {
      if(request.method==="GET")expect(request.headers.get("if-match")).toBe('"sealed"');
      data=Buffer.from(files.get(name)!);headers.set("content-length",String(data.length));
    }
    return{request,status,headers,bodyAsText,readableStreamBody:Readable.from(data)};
  }}});
  const container=new BlobServiceClient(`https://${f.config.storageAccount}.blob.core.windows.net`,pipeline).getContainerClient(f.config.container);
  const job=f.job;
  let reserved=false,stage="ready",start=false;
  const check=(c:unknown,m:unknown,j:unknown)=>{
    if(managedDigest(managedImportBudgetRequest(c,m,j,f.policy,f.binding,f.pricingDigest,null))!==managedDigest(f.request))throw Error("fictional_budget_changed");
  };
  const budget:ManagedKohoBudget={prepareImport:vi.fn(async()=>({...f.config,serviceBudget:f.config.serviceBudget!,budgetBinding:f.config.budgetBinding!})),
    reserveImport:vi.fn(async(c,m,j)=>{check(c,m,j);calls.push("budget:reserve");if(reserved)return{created:false};reserved=true;return{created:true};}),
    claimImport:vi.fn(async(c,m,j,phase)=>{check(c,m,j);calls.push(`budget:${phase}`);if(!reserved)throw Error();
      if(phase==="stage"){if(stage!=="ready")throw Error();stage="claimed";}else{if(stage!=="done"||start)throw Error();start=true;}}),
    confirmImport:vi.fn(async(c,m,j)=>{check(c,m,j);calls.push("budget:confirm");if(stage!=="claimed"&&stage!=="done")throw Error();stage="done";}),markUnknown:vi.fn(async()=>{}),
    verifyImportStaging:vi.fn(async(c,m,j)=>{check(c,m,j);if(!reserved||start||!["claimed","done"].includes(stage))throw Error();return null;}),
    verifyArchiveRelease:vi.fn(async()=>{if(stage!=="done")throw Error();})};
  const input={schema:1,command:"stage",config:f.config,manifest:f.manifest,job,sources:[{sha256:f.manifest.packages[0].sha256,path:sourcePath}]};
  const arm=vi.fn(async(_url:string,method:"GET"|"POST",body?:unknown):Promise<{status:number;body:unknown}>=>{
    if(method==="POST")return{status:202,body};
    return{status:200,body:{id:job.resourceId,properties:{environmentId:f.config.expectedEnvironmentResourceId,
      configuration:{triggerType:"Manual",replicaRetryLimit:0,replicaTimeout:7200,manualTriggerConfig:{parallelism:1,replicaCompletionCount:1}},
      template:{containers:[{name:"existing-container",image:job.image}]}}}};
  });
  return{...f,path,sourcePath,input,container,arm,files,calls,budget,
    rebind:()=>{f.request=managedImportBudgetRequest(f.config,f.manifest,f.job,f.policy,f.binding,f.pricingDigest,null);f.config.serviceBudget!.requestDigest=f.request.requestDigest;},
    lose:(name:string)=>{loseAck=name;},expire:(name:string)=>{expireAfter=name;},failHead:(code:string)=>{headFailure=code;},creationAge:(ms:number)=>{creationAgeMs=ms;}};
}
async function verificationContinuationFixture(){
  const f=await fixture(true),pkg={...f.manifest.packages[0],etag:'"sealed"'},name=cloudReceiptPrefix(f.config)+"archive-verification-recovery-started.json";
  const bytes=Buffer.from(JSON.stringify({operationId:f.config.operationId,identityDigest:managedDigest(archivePackageIdentity(pkg)),etag:pkg.etag}));f.files.set(name,bytes);
  return{...f,pkg,name,proof:{localCodeSha:"e".repeat(40),priorFailureSha256:"f".repeat(64),priorSenderTerminated:true as const,markerSha256:sha256(bytes)}};
}
it("continues committed-byte verification only within the existing recovery deadline",async()=>{
  const f=await verificationContinuationFixture(),before=Buffer.from(f.files.get(f.name)!);
  await confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},f.proof);
  const marker=JSON.parse(f.files.get(cloudReceiptPrefix(f.config)+"archive-verification-continuation-started.json")!.toString());
  expect(Date.parse(marker.verifyNotAfter)).toBeLessThan(Date.now()+15*60_000);expect(f.files.get(f.name)).toEqual(before);
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(1);
  await confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},f.proof);
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(1);
});
it.each(["expired","future","hash","identity","absent","already-claimed"])("refuses verification continuation %s before reading source bytes",async(kind)=>{
  const f=await verificationContinuationFixture();
  if(kind==="expired")f.creationAge(15*60_000);
  if(kind==="future")f.creationAge(-60_000);
  if(kind==="hash")f.proof.markerSha256="0".repeat(64);
  if(kind==="identity"){const b=Buffer.from(JSON.stringify({operationId:f.config.operationId,identityDigest:"0".repeat(64),etag:f.pkg.etag}));f.files.set(f.name,b);f.proof.markerSha256=sha256(b);}
  if(kind==="absent")f.files.delete(f.name);
  if(kind==="already-claimed")f.files.set(cloudReceiptPrefix(f.config)+"archive-verification-continuation-started.json",Buffer.from("{}"));
  await expect(confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},f.proof)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(0);
});
async function verificationRecoveryFixture(){
  const f=await verificationContinuationFixture(),prefix=cloudReceiptPrefix(f.config),slot=f.files.get(f.name)!;
  f.files.set(prefix+"archive-verification-started.json",Buffer.from(slot));
  const last=Buffer.from(JSON.stringify({...JSON.parse(slot.toString()),markerSha256:sha256(slot),verifyNotAfter:new Date(Date.now()-60_000).toISOString()}));
  f.files.set(prefix+"archive-verification-continuation-started.json",last);
  const recovery={localCodeSha:"e".repeat(40),ownerApprovalSha256:"a".repeat(64),priorEvidenceSha256:"b".repeat(64),priorSenderTerminated:true as const,
    priorMarkerSha256:[sha256(slot),sha256(slot),sha256(last)] as [string,string,string],maxElapsedMs:30*60_000};
  return{...f,prefix,recovery};
}
it("performs one explicitly evidenced recovery while preserving all previous verification markers",async()=>{
  const f=await verificationRecoveryFixture(),before=new Map([...f.files].map(([k,v])=>[k,Buffer.from(v)]));
  await confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},undefined,f.recovery);
  for(const [k,v] of before)expect(f.files.get(k)).toEqual(v);
  const marker=JSON.parse(f.files.get(f.prefix+"archive-verification-owner-recovery-started.json")!.toString());
  expect(marker.maxElapsedMs).toBe(f.recovery.maxElapsedMs);expect(Date.parse(marker.verifyNotAfter)).toBeLessThanOrEqual(Date.now()+f.recovery.maxElapsedMs);
  await confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},undefined,f.recovery);
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(1);
});
it.each(["hash","slot-identity","last-etag","last-link","not-ended","limit","already-claimed","normal","mixed"])("rejects unsafe explicit verification recovery %s",async(kind)=>{
  const f=await verificationRecoveryFixture();
  if(kind==="hash")f.recovery.priorMarkerSha256[0]="0".repeat(64);
  if(kind==="slot-identity"){const b=Buffer.from("{}");f.files.set(f.prefix+"archive-verification-started.json",b);f.recovery.priorMarkerSha256[0]=sha256(b);}
  if(["last-etag","last-link","not-ended"].includes(kind)){
    const name=f.prefix+"archive-verification-continuation-started.json",v=JSON.parse(f.files.get(name)!.toString());
    if(kind==="last-etag")v.etag='"other"';if(kind==="last-link")v.markerSha256="0".repeat(64);if(kind==="not-ended")v.verifyNotAfter=new Date(Date.now()+60_000).toISOString();
    const b=Buffer.from(JSON.stringify(v));f.files.set(name,b);f.recovery.priorMarkerSha256[2]=sha256(b);
  }
  if(kind==="limit")f.recovery.maxElapsedMs++;
  if(kind==="already-claimed")f.files.set(f.prefix+"archive-verification-owner-recovery-started.json",Buffer.from("{}"));
  await expect(confirmArchiveReceipt(f.container,f.config,f.pkg,kind!=="normal",()=>{},kind==="mixed"?f.proof:undefined,f.recovery)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(0);
});
it("does not replay explicit verification after a lost claim acknowledgement",async()=>{
  const f=await verificationRecoveryFixture(),name=f.prefix+"archive-verification-owner-recovery-started.json";f.lose(name);
  await expect(confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},undefined,f.recovery)).rejects.toThrow();f.lose("");
  const first=Buffer.from(f.files.get(name)!);
  await expect(confirmArchiveReceipt(f.container,f.config,f.pkg,true,()=>{},undefined,f.recovery)).rejects.toThrow();
  expect(f.files.get(name)).toEqual(first);expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(0);
});
async function verificationRecoveryOperatorFixture(){
  const f=await verificationRecoveryFixture();f.manifest.maxElapsedMs=65*60_000;f.rebind();
  f.lose(f.prefix+"staging-started.json");await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  const now=Date.parse(f.manifest.expiresAt)+1;vi.spyOn(Date,"now").mockReturnValue(now);
  const reference={sha256:"8".repeat(64),localCodeSha:"9".repeat(40),executionCodeSha:f.recovery.localCodeSha};
  const permit={sha256:reference.sha256,expiresAt:new Date(now+3*60*60_000).toISOString()};
  const original=vi.mocked(f.budget.verifyImportStaging).getMockImplementation()!;
  vi.mocked(f.budget.verifyImportStaging).mockImplementation(async(...args)=>{await original(...args);expect(args[3]).toEqual(reference);return permit;});
  f.calls.length=0;
  return{...f,reference,permit,input:{...f.input,command:"reconcile-stage",sources:[] as typeof f.input.sources,renewalReference:reference,verificationRecovery:f.recovery}};
}
it("seals explicitly recovered archive bytes through the operator with its original claim and renewed reference",async()=>{
  const f=await verificationRecoveryOperatorFixture(),before=structuredClone(f.manifest),history=Buffer.from(f.files.get(f.prefix+"staging-started.json")!);
  const result=await operateManagedKoho(f.input,f.container,f.arm,f.budget);
  expect(result).toMatchObject({status:"staged",manifest:{expiresAt:before.expiresAt},archive:{operationId:f.config.operationId,
    manifestSha256:sha256(f.files.get(cloudManifestName(f.config))!),receiptSha256:sha256(f.files.get(archiveReceiptName(f.config.operationId))!)}});
  expect(f.files.has(f.prefix+"staged.json")).toBe(true);expect(f.files.get(f.prefix+"staging-started.json")).toEqual(history);expect(f.manifest).toEqual(before);
  expect(f.budget.verifyImportStaging).toHaveBeenCalledWith(expect.anything(),expect.anything(),f.job,f.reference);
  expect(f.budget.confirmImport).toHaveBeenCalledWith(expect.anything(),expect.anything(),f.job,f.reference);
  expect(f.budget.reserveImport).toHaveBeenCalledOnce();expect(f.budget.claimImport).toHaveBeenCalledOnce();
  expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(1);
  expect(f.calls.filter(c=>c===`PUT:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(0);expect(f.arm).not.toHaveBeenCalled();
});
it.each(["sources","executor-sha","manifest-time","effective-expiry"])("rejects explicit verification recovery at the operator boundary: %s",async(kind)=>{
  const f=await verificationRecoveryOperatorFixture();
  if(kind==="sources")f.input.sources=[{sha256:f.pkg.sha256,path:f.sourcePath}];
  if(kind==="executor-sha")f.input.renewalReference.executionCodeSha="0".repeat(40);
  if(kind==="manifest-time")f.manifest.maxElapsedMs=f.recovery.maxElapsedMs+60_000;
  if(kind==="effective-expiry")f.permit.expiresAt=new Date(Date.now()+f.recovery.maxElapsedMs+60_000).toISOString();
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.budget.verifyImportStaging).toHaveBeenCalledTimes(kind==="effective-expiry"?1:0);expect(f.budget.confirmImport).not.toHaveBeenCalled();
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toHaveLength(0);expect(f.calls.filter(c=>c===`GET:${cloudSourceName(f.pkg.sha256)}`)).toHaveLength(0);
  expect(f.files.has(archiveReceiptName(f.config.operationId))).toBe(false);expect(f.files.has(cloudManifestName(f.config))).toBe(false);expect(f.arm).not.toHaveBeenCalled();
});
it.each(["manifest","staged"])("recovers lost %s ACK from original approved input, without writes or ARM calls",async(which)=>{
  const f=await fixture();f.lose(which==="manifest"?cloudManifestName(f.config):cloudReceiptPrefix(f.config)+"staged.json");
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  const writes=f.calls.filter(c=>c.startsWith("PUT:"));vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
  const result=await operateManagedKoho({...f.input,command:"status"},f.container,f.arm,f.budget);
  expect(result.status).toBe("staged");expect(result).toMatchObject({config:{manifest:{etag:'"sealed"'}},manifest:{packages:[{etag:'"sealed"'}]}});
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual(writes);expect(f.arm).not.toHaveBeenCalled();
  await expect(operateManagedKoho({...f.input,command:"status",manifest:{...f.manifest,round:2}},f.container,f.arm,f.budget)).rejects.toThrow();
});
it.each(["get","marker"])("does not send start after expiry during %s acknowledgement",async(where)=>{
  const f=await fixture(),sealed=await operateManagedKoho(f.input,f.container,f.arm,f.budget);expect(sealed.status).toBe("staged");
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  if(where==="get"){
    const original=f.arm.getMockImplementation()!;f.arm.mockImplementation(async(...args)=>{
      const r=await original(...args);vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);return r;
    });
  }else f.expire(cloudReceiptPrefix(f.config)+"start-requested.json");
  await expect(operateManagedKoho({...f.input,config:sealed.config,manifest:sealed.manifest,command:"start"},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.arm.mock.calls.filter(c=>c[1]==="GET")).toHaveLength(1);
  expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(0);
});
it("sends one fixed start, retains ambiguous reservation, and checks historical receipts after expiry",async()=>{
  const f=await fixture(),sealed=await operateManagedKoho(f.input,f.container,f.arm,f.budget);
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  const input={...f.input,config:sealed.config,manifest:sealed.manifest,command:"start"};
  await expect(operateManagedKoho({...input,job:{...input.job,databaseSecretRef:"other-import"}},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.arm).not.toHaveBeenCalled();
  expect((await operateManagedKoho(input,f.container,f.arm,f.budget)).status).toBe("submitting");
  await expect(operateManagedKoho(input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(1);
  const body=f.arm.mock.calls.find(c=>c[1]==="POST")![2];
  expect(body).toMatchObject({initContainers:[],containers:[{name:"existing-container",resources:{cpu:2,memory:"4Gi"},env:expect.arrayContaining([{name:"KOHO_CLOUD_DATABASE_PASSWORD",secretRef:"fictional-import"},
    {name:"MANAGED_BUDGET_TARGET_SHA256",value:f.binding.targetBindingHash}])}]});
  vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
  expect(await operateManagedKoho({...f.input,command:"status"},f.container,f.arm,f.budget)).toMatchObject({status:"reconciliation_required",stage:"start_requested"});
  f.files.set(cloudReceiptPrefix(f.config)+"finished.json",Buffer.from(JSON.stringify({operationId:f.config.operationId,manifestSha256:sealed.config.manifest.sha256,
    codeSha:f.config.expectedCodeSha,status:"complete",cleanup:"complete",capacityConfirmed:true,databaseGrowthBytes:12})));
  expect(await operateManagedKoho({...f.input,command:"status"},f.container,f.arm,f.budget)).toEqual({status:"complete",cleanup:"complete",capacityConfirmed:true,databaseGrowthBytes:12});
});
it("rejects an existing auxiliary init container before claiming or submitting a job",async()=>{
  const f=await fixture(),sealed=await operateManagedKoho(f.input,f.container,f.arm,f.budget);
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  const original=f.arm.getMockImplementation()!;f.arm.mockImplementation(async(...args)=>{
    const result=await original(...args);if(args[1]==="GET"){
      const b=result.body as {properties:{template:{initContainers?:unknown}}};b.properties.template.initContainers=[{name:"fictional-unapproved-init"}];
    }return result;
  });
  const claims=vi.mocked(f.budget.claimImport).mock.calls.length;
  await expect(operateManagedKoho({...f.input,command:"start",config:sealed.config,manifest:sealed.manifest},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(vi.mocked(f.budget.claimImport).mock.calls).toHaveLength(claims);expect(f.arm.mock.calls.filter(c=>c[1]==="POST")).toHaveLength(0);
});
it("rejects a same-size corrupt Azure source before sealing or starting",async()=>{
  const f=await fixture(true),source=cloudSourceName(f.manifest.packages[0].sha256),bad=Buffer.from(f.data);bad[0]^=1;f.files.set(source,bad);
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.files.has(archiveReceiptName(f.config.operationId))).toBe(false);expect(f.files.has(cloudManifestName(f.config))).toBe(false);
  expect(await readFile(f.sourcePath)).toEqual(f.data);expect(f.arm).not.toHaveBeenCalled();
});
it.each(["source","receipt","manifest","staged"])("recovers archive %s ACK loss with no second upload/reservation",async(where)=>{
  const f=await fixture(true),source=cloudSourceName(f.manifest.packages[0].sha256);
  if(where==="source")f.files.delete(source);
  f.lose(where==="source"?source:where==="receipt"?archiveReceiptName(f.config.operationId):where==="manifest"?cloudManifestName(f.config):cloudReceiptPrefix(f.config)+"staged.json");
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  const writes=f.calls.filter(c=>c===`PUT:${source}`).length;
  const recovered=await operateManagedKoho({...f.input,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget);
  expect(recovered).toMatchObject({status:"staged",archive:{operationId:f.config.operationId}});
  expect(f.calls.filter(c=>c===`PUT:${source}`)).toHaveLength(writes);expect(f.budget.reserveImport).toHaveBeenCalledOnce();expect(f.budget.claimImport).toHaveBeenCalledOnce();
  const reads=f.calls.filter(c=>c===`GET:${source}`).length;
  await operateManagedKoho({...f.input,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget);
  expect(f.calls.filter(c=>c===`GET:${source}`)).toHaveLength(reads);expect(f.arm).not.toHaveBeenCalled();
});
it("does not permit an archive-only manifest to start a Job or enter the worker",async()=>{
  const f=await fixture(true),sealed=await operateManagedKoho(f.input,f.container,f.arm,f.budget);
  if(!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  await expect(operateManagedKoho({...f.input,command:"start",config:sealed.config,manifest:sealed.manifest,sources:[]},f.container,f.arm,f.budget)).rejects.toThrow();
  f.blob.objects.set(cloudManifestName(sealed.config),{bytes:Buffer.from(JSON.stringify(sealed.manifest)),etag:sealed.config.manifest.etag});
  const download=vi.spyOn(f.blob,"download"),save=vi.fn();
  expect((await runCloudImport(sealed.config,f.blob,{password:"FICTIONAL",save,budget:{verify:vi.fn()}})).startedAcknowledged).toBe(false);
  expect(download).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled();expect(f.arm).not.toHaveBeenCalled();
});
it("holds one owned ZIP, releases only after Azure proof, and permits cloud use after Local removal",async()=>{
  const f=await fixture(true),pkg=f.manifest.packages[0],original=await readFile(f.sourcePath);
  const transfer=await copyManagedTransfer({sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt},f.path);
  await expect(copyManagedTransfer({sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt},f.path)).rejects.toThrow();
  const before={...pkg,archive:{operationId:f.config.operationId,manifestSha256:f.config.manifest.sha256,receiptSha256:"a".repeat(64)}};
  await expect(releaseManagedTransfer({transferId:transfer.transferId,config:f.config,package:before},f.container,f.path)).rejects.toThrow();
  expect((await lstat(transfer.sourcePath)).size).toBe(pkg.byteLength);
  const result=await operateManagedKoho({...f.input,sources:[{sha256:pkg.sha256,path:transfer.sourcePath}]},f.container,f.arm,f.budget);
  if(!("archive"in result)||!result.archive||!("config"in result)||!result.config||!("manifest"in result)||!result.manifest)throw Error();
  const archivedPackage={...result.manifest.packages[0],archive:result.archive};
  const release={transferId:transfer.transferId,config:result.config,package:archivedPackage};
  expect(await releaseManagedTransfer(release,f.container,f.path)).toMatchObject({status:"released"});
  await expect(lstat(transfer.sourcePath)).rejects.toMatchObject({code:"ENOENT"});expect(await readFile(f.sourcePath)).toEqual(original);
  expect(await releaseManagedTransfer(release,f.container,f.path)).toMatchObject({status:"released"});
  const next=await copyManagedTransfer({sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt},f.path);
  expect(await releaseManagedTransfer(release,f.container,f.path)).toMatchObject({status:"released"});expect((await lstat(next.sourcePath)).size).toBe(pkg.byteLength);
  const g=await fixture();g.manifest.packages=[archivedPackage];g.rebind();for(const[name,bytes]of f.files)g.files.set(name,bytes);
  const batch=await operateManagedKoho({...g.input,sources:[]},g.container,g.arm,g.budget);
  expect(batch.status).toBe("staged");expect(g.calls.filter(c=>c.startsWith("PUT:inputs/"))).toHaveLength(0);
  if(!("config"in batch)||!batch.config||!("manifest"in batch)||!batch.manifest)throw Error();
  const manifestBytes=Buffer.from(JSON.stringify(batch.manifest));g.blob.objects.set(cloudManifestName(batch.config),{bytes:manifestBytes,etag:batch.config.manifest.etag});
  g.blob.objects.set(cloudSourceName(pkg.sha256),{bytes:f.data,etag:archivedPackage.etag});
  const save=vi.fn(async(_c,_m,_p,plan,begin)=>{begin();return{outcome:"inserted" as const,savedDocumentCount:plan.documentCount,databaseGrowthBytes:1,capacityConfirmed:true};});
  const verify=vi.fn(async()=>({expiresAt:g.manifest.expiresAt,remainingMs:60*60_000}));
  expect((await runCloudImport(batch.config,g.blob,{password:"FICTIONAL",save,budget:{verify}})).status).toBe("complete");expect(save).toHaveBeenCalledOnce();
});
it("bounds recovery verification to one full read and never reuploads a missing source",async()=>{
  const f=await fixture(true),source=cloudSourceName(f.manifest.packages[0].sha256),slot=cloudReceiptPrefix(f.config)+"archive-verification-started.json";
  f.lose(slot);await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  const results=await Promise.allSettled([1,2].map(()=>operateManagedKoho({...f.input,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(f.calls.filter(c=>c===`GET:${source}`)).toHaveLength(1);
  f.files.delete(source);const writes=f.calls.filter(c=>c===`PUT:${source}`).length;
  await expect(operateManagedKoho({...f.input,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`PUT:${source}`)).toHaveLength(writes);
});
it("accepts one new download directly into the owned slot without creating an outside original",async()=>{
  const f=await fixture(true),pkg=f.manifest.packages[0];
  const sourceIdentity={packageType:"JPA",issueNumber:pkg.issueNumber,publicationDate:pkg.publicationDate,distributionTableSha256:pkg.distributionTableSha256};
  const allocated=await allocateManagedDownload({maxBytes:8*1024**3,sourceIdentity},f.path);
  await expect(allocateManagedDownload({maxBytes:8*1024**3,sourceIdentity},f.path)).rejects.toThrow();
  await writeFile(allocated.destination,f.data,{flag:"wx"});const acquiredAt=new Date().toISOString();
  const completed=await completeManagedDownload({transferId:allocated.transferId,acquiredAt},f.path);
  expect(completed).toMatchObject({byteLength:f.data.length,sha256:pkg.sha256,sourceIdentity});
  expect(await completeManagedDownload({transferId:allocated.transferId,acquiredAt},f.path)).toEqual(completed);
  expect(await managedTransferStatus(f.path)).toMatchObject({status:"transfer_pending",record:{transferId:allocated.transferId}});
  await expect(completeManagedDownload({transferId:allocated.transferId,acquiredAt:new Date(Date.now()+3600_000).toISOString()},f.path)).rejects.toThrow();
});
it("records ownership before bytes and resumes only a matching partial copy without truncation",async()=>{
  const f=await fixture(true),partial=join(f.path,"owned-partial.zip");let identity:{dev:number;ino:number}|undefined;
  await expect(copyManualSource(f.sourcePath,partial,f.data.length,async stat=>{identity={dev:Number(stat.dev),ino:Number(stat.ino)};throw Error("FICTIONAL_CRASH");})).rejects.toThrow();
  expect((await lstat(partial)).size).toBe(0);
  const {resumeManualSourceCopy}=await import("../src/lib/koho-import/manual-cli-source");
  await writeFile(partial,f.data.subarray(0,7));
  const wrong=join(f.path,"wrong-original.zip"),changed=Buffer.from(f.data);changed[changed.length-1]^=1;await writeFile(wrong,changed);
  await expect(resumeManualSourceCopy(wrong,partial,f.data.length,f.manifest.packages[0].sha256,identity!)).rejects.toThrow();
  expect(await readFile(partial)).toEqual(f.data.subarray(0,7));
  await resumeManualSourceCopy(f.sourcePath,partial,f.data.length,f.manifest.packages[0].sha256,identity!);
  expect(await readFile(partial)).toEqual(f.data);expect(await readFile(f.sourcePath)).toEqual(f.data);
  await writeFile(partial,Buffer.from("corrupt"));
  await expect(resumeManualSourceCopy(f.sourcePath,partial,f.data.length,f.manifest.packages[0].sha256,identity!)).rejects.toThrow();
  expect(await readFile(partial)).toEqual(Buffer.from("corrupt"));
});
it.each(["owner","empty","created","copied"])("resumes the transfer entrypoint after %s without replacing originals",async(point)=>{
  const f=await fixture(true),pkg=f.manifest.packages[0],input={sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt};
  const transfer=await copyManagedTransfer(input,f.path),dir=dirname(transfer.sourcePath);
  await unlink(join(dir,"copied.json"));
  if(point==="owner"||point==="empty")await unlink(join(dir,"created.json"));
  if(point==="owner")await unlink(transfer.sourcePath);
  if(point==="empty")await writeFile(transfer.sourcePath,Buffer.alloc(0));
  if(point==="created")await writeFile(transfer.sourcePath,f.data.subarray(0,7));
  expect(await copyManagedTransfer({...input,transferId:transfer.transferId},f.path)).toEqual(transfer);
  expect(await readFile(f.sourcePath)).toEqual(f.data);expect(await readFile(transfer.sourcePath)).toEqual(f.data);
});
it.each(["release-recorded","zip-deleted"])("recovers cleanup after %s and preserves the original",async(point)=>{
  const f=await fixture(true),pkg=f.manifest.packages[0],transfer=await copyManagedTransfer({sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt},f.path);
  const sealed=await operateManagedKoho({...f.input,sources:[{sha256:pkg.sha256,path:transfer.sourcePath}]},f.container,f.arm,f.budget);
  if(!("archive"in sealed)||!sealed.archive||!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  const release={transferId:transfer.transferId,archive:sealed.archive,sha256:pkg.sha256,byteLength:pkg.byteLength};
  await writeFile(join(dirname(transfer.sourcePath),"release.json"),JSON.stringify(release),{flag:"wx"});
  if(point==="zip-deleted")await unlink(transfer.sourcePath);
  vi.spyOn(process,"cwd").mockReturnValue(f.path);
  expect(await operateManagedKoho({...f.input,command:"release-transfer",transferId:transfer.transferId,sources:[],config:sealed.config,manifest:sealed.manifest},f.container,f.arm,f.budget)).toMatchObject({status:"released"});
  expect(f.budget.verifyArchiveRelease).toHaveBeenCalledOnce();expect(await readFile(f.sourcePath)).toEqual(f.data);
});
it("refuses a hard-linked download and does not retry direct-import full reads",async()=>{
  const f=await fixture(true),pkg=f.manifest.packages[0];
  const allocated=await allocateManagedDownload({maxBytes:8*1024**3,sourceIdentity:{packageType:"JPA",issueNumber:pkg.issueNumber,publicationDate:pkg.publicationDate,distributionTableSha256:pkg.distributionTableSha256}},f.path);
  await link(f.sourcePath,allocated.destination);
  await expect(completeManagedDownload({transferId:allocated.transferId,acquiredAt:new Date().toISOString()},f.path)).rejects.toThrow();
  expect(await readFile(f.sourcePath)).toEqual(f.data);
  const g=await fixture();await operateManagedKoho(g.input,g.container,g.arm,g.budget);const calls=[...g.calls];
  await expect(operateManagedKoho({...g.input,command:"reconcile-stage",sources:[]},g.container,g.arm,g.budget)).rejects.toThrow();
  expect(g.calls.slice(calls.length).filter(c=>c.startsWith("GET:inputs/"))).toHaveLength(0);
});
async function partialArchive(){
  const f=await fixture(true),source=cloudSourceName(f.manifest.packages[0].sha256);
  f.manifest.maxElapsedMs=65*60_000;f.rebind();
  f.files.delete(source);f.lose(cloudReceiptPrefix(f.config)+"staging-started.json");
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  const recovery={...f.input,command:"recover-archive-upload",uploadRecovery:{localCodeSha:"f".repeat(40),ownerApprovalSha256:"a".repeat(64),
    priorFailureSha256:"b".repeat(64),priorSenderTerminated:true,maxUploadElapsedMs:60_000}};
  return{...f,source,recovery};
}
it("recovers one missing archive without reserving, claiming or starting again",async()=>{
  const f=await partialArchive(),history=Buffer.from(f.files.get(cloudReceiptPrefix(f.config)+"staging-started.json")!);
  const result=await operateManagedKoho(f.recovery,f.container,f.arm,f.budget);
  expect(result).toMatchObject({status:"staged",archive:{operationId:f.config.operationId},config:{expectedCodeSha:f.config.expectedCodeSha}});
  expect(f.budget.reserveImport).toHaveBeenCalledOnce();expect(f.budget.claimImport).toHaveBeenCalledOnce();expect(f.budget.verifyImportStaging).toHaveBeenCalledOnce();
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(1);expect(f.calls.filter(c=>c===`GET:${f.source}`)).toHaveLength(1);
  expect(f.files.get(cloudReceiptPrefix(f.config)+"staging-started.json")).toEqual(history);expect(f.arm).not.toHaveBeenCalled();
  expect(await readFile(f.sourcePath)).toEqual(f.data);
});
it("allows only one concurrent recovery and never replays a lost recovery marker ACK",async()=>{
  const f=await partialArchive();f.lose(cloudReceiptPrefix(f.config)+"upload-recovery-started.json");
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);
  const g=await partialArchive();const results=await Promise.allSettled([1,2].map(()=>operateManagedKoho(g.recovery,g.container,g.arm,g.budget)));
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(g.calls.filter(c=>c===`PUT:${g.source}`)).toHaveLength(1);
});
it("uses ordinary reconciliation after recovery upload ACK loss, with no second source send",async()=>{
  const f=await partialArchive();f.lose(f.source);
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(await operateManagedKoho({...f.input,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget)).toMatchObject({status:"staged"});
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(1);expect(f.budget.reserveImport).toHaveBeenCalledOnce();
});
it.each(["source","binding","approval","sender","deadline","expiry","sealed"])("rejects unsafe recovery %s before a source write",async(kind)=>{
  const f=await partialArchive();
  if(kind==="source"){const bad=Buffer.from(f.data);bad[0]^=1;await writeFile(f.sourcePath,bad);}
  if(kind==="binding")f.recovery.manifest.round++;
  if(kind==="approval")f.recovery.uploadRecovery.ownerApprovalSha256="";
  if(kind==="sender")f.recovery.uploadRecovery.priorSenderTerminated=false;
  if(kind==="deadline")f.recovery.uploadRecovery.maxUploadElapsedMs=f.manifest.maxElapsedMs;
  if(kind==="expiry")vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)-60_000);
  if(kind==="sealed")f.files.set(f.source,f.data);
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);expect(f.arm).not.toHaveBeenCalled();
});
it("does not accept recovery parameters on normal stage or recovery on a non-archive import",async()=>{
  const f=await partialArchive();
  await expect(operateManagedKoho({...f.recovery,command:"stage"},f.container,f.arm,f.budget)).rejects.toThrow();
  delete f.recovery.manifest.archiveOnly;
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);
});
it.each(["AuthorizationPermissionMismatch","ContainerNotFound","bare404","timeout"])("does not upload on unknown source HEAD: %s",async(code)=>{
  const f=await partialArchive();f.failHead(code);
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.files.has(cloudReceiptPrefix(f.config)+"upload-recovery-started.json")).toBe(false);
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);
});
it("stops after expiry during recovery marker acknowledgement without uploading",async()=>{
  const f=await partialArchive();f.expire(cloudReceiptPrefix(f.config)+"upload-recovery-started.json");
  await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);
});
async function tailArchive(){
  const f=await partialArchive(),name=cloudReceiptPrefix(f.config)+"upload-recovery-started.json";
  f.lose(name);await expect(operateManagedKoho(f.recovery,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  const input={...f.input,command:"recover-archive-tail",tailRecovery:{localCodeSha:"e".repeat(40),ownerApprovalSha256:"a".repeat(64),
    priorFailureSha256:"c".repeat(64),priorEvidenceSha256:"d".repeat(64),priorRecoveryMarkerSha256:sha256(f.files.get(name)!),priorSenderTerminated:true,
    priorStartedAt:new Date(Date.now()-40_000).toISOString(),priorTerminatedObservedAt:new Date(Date.now()-10_000).toISOString(),
    maxUploadElapsedMs:60_000,blockListSha256:"e".repeat(64),blockIdPrefix:"11111111-1111-4111-8111-111111111111"}};
  return{...f,input,name};
}
it("verifies committed tail bytes before sealing, with no new reservation, claim or job",async()=>{
  const f=await tailArchive();const tail=vi.spyOn(tailOperator,"resumeArchiveTail").mockImplementation(async()=>{f.files.set(f.source,f.data);});
  expect(await operateManagedKoho(f.input,f.container,f.arm,f.budget)).toMatchObject({status:"staged"});
  expect(tail).toHaveBeenCalledOnce();expect(f.budget.reserveImport).toHaveBeenCalledOnce();expect(f.budget.claimImport).toHaveBeenCalledOnce();
  expect(f.calls.filter(c=>c===`GET:${f.source}`)).toHaveLength(1);expect(f.arm).not.toHaveBeenCalled();
});
it("never seals a same-size corrupt committed tail",async()=>{
  const f=await tailArchive(),bad=Buffer.from(f.data);bad[0]^=1;
  vi.spyOn(tailOperator,"resumeArchiveTail").mockImplementation(async()=>{f.files.set(f.source,bad);});
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.files.has(archiveReceiptName(f.config.operationId))).toBe(false);expect(f.files.has(cloudManifestName(f.config))).toBe(false);
  expect(f.budget.confirmImport).not.toHaveBeenCalled();
});
it.each(["operation","source","bytes","expiry","committed","normal-command"])("rejects unsafe tail %s before dispatch",async(kind)=>{
  const f=await tailArchive(),tail=vi.spyOn(tailOperator,"resumeArchiveTail");
  const marker=JSON.parse(f.files.get(f.name)!.toString());
  if(kind==="operation")marker.operationId="22222222-2222-4222-8222-222222222222";
  if(kind==="source")marker.sourceSha256="0".repeat(64);
  if(kind==="bytes")marker.sourceBytes++;
  f.files.set(f.name,Buffer.from(JSON.stringify(marker)));
  if(kind==="expiry")vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
  if(kind==="committed")f.files.set(f.source,f.data);
  if(kind==="normal-command")f.input.command="stage";
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();expect(tail).not.toHaveBeenCalled();
  expect(f.budget.reserveImport).toHaveBeenCalledOnce();expect(f.arm).not.toHaveBeenCalled();
});
it("uses an explicit renewed expiry for tail and lost-ACK reconciliation while preserving the old manifest",async()=>{
  const f=await tailArchive(),old=structuredClone(f.manifest),now=Date.parse(f.manifest.expiresAt)+1;
  vi.spyOn(Date,"now").mockReturnValue(now);
  const reference={sha256:"8".repeat(64),localCodeSha:"e".repeat(40)},expiresAt=new Date(now+3*60*60_000).toISOString();
  vi.mocked(f.budget.verifyImportStaging).mockImplementation(async(_c,_m,_j,ref)=>{if(ref?.sha256!==reference.sha256)throw Error();return{...reference,expiresAt};});
  const tail=vi.spyOn(tailOperator,"resumeArchiveTail").mockImplementation(async()=>{f.files.set(f.source,f.data);});
  const input={...f.input,renewalReference:reference};f.lose(cloudReceiptPrefix(f.config)+"staged.json");
  await expect(operateManagedKoho(input,f.container,f.arm,f.budget)).rejects.toThrow();f.lose("");
  expect(f.manifest).toEqual(old);
  const {tailRecovery,...plain}=input;void tailRecovery;
  const result=await operateManagedKoho({...plain,command:"reconcile-stage",sources:[]},f.container,f.arm,f.budget);
  expect(result).toMatchObject({status:"staged",manifest:{expiresAt:old.expiresAt}});expect(tail).toHaveBeenCalledOnce();
  expect(f.budget.confirmImport).toHaveBeenCalledWith(expect.anything(),expect.anything(),f.job,reference);expect(f.arm).not.toHaveBeenCalled();
  await expect(operateManagedKoho({...plain,command:"stage"},f.container,f.arm,f.budget)).rejects.toThrow();
});
it("dispatches explicit expiry renewal with the old staging binding, without sending a source",async()=>{
  const f=await partialArchive(),now=Date.parse(f.manifest.expiresAt)+1;vi.spyOn(Date,"now").mockReturnValue(now);
  f.budget.renewArchiveStaging=vi.fn(async()=>({reference:{sha256:"8".repeat(64),localCodeSha:"e".repeat(40)},record:{} as never}));
  const input={...f.input,command:"renew-archive-expiry",sources:[],expiryRenewal:{localCodeSha:"e".repeat(40),ownerApprovalSha256:"a".repeat(64),
    priorEvidenceSha256:"b".repeat(64),originalOperationDigest:"c".repeat(64),windowMs:3*60*60_000}};
  expect(await operateManagedKoho(input,f.container,f.arm,f.budget)).toMatchObject({status:"expiry_renewed"});
  expect(f.budget.renewArchiveStaging).toHaveBeenCalledOnce();expect(f.calls.filter(c=>c===`PUT:${f.source}`)).toHaveLength(0);expect(f.arm).not.toHaveBeenCalled();
  await expect(operateManagedKoho({...input,manifest:{...input.manifest,round:99}},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.budget.renewArchiveStaging).toHaveBeenCalledOnce();
});
it("rejects a tail build different from the renewal reference before dispatch",async()=>{
  const f=await tailArchive(),tail=vi.spyOn(tailOperator,"resumeArchiveTail");
  await expect(operateManagedKoho({...f.input,renewalReference:{sha256:"8".repeat(64),localCodeSha:"9".repeat(40)}},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(tail).not.toHaveBeenCalled();
});
it("keeps the issuer reference while explicitly binding a reviewed continuation build",async()=>{
  const f=await tailArchive(),now=Date.parse(f.manifest.expiresAt)+1;vi.spyOn(Date,"now").mockReturnValue(now);
  const reference={sha256:"8".repeat(64),localCodeSha:"9".repeat(40),executionCodeSha:f.input.tailRecovery.localCodeSha};
  vi.mocked(f.budget.verifyImportStaging).mockResolvedValue({sha256:reference.sha256,expiresAt:new Date(now+3*60*60_000).toISOString()});
  const tail=vi.spyOn(tailOperator,"resumeArchiveTail").mockImplementation(async()=>{f.files.set(f.source,f.data);});
  expect(await operateManagedKoho({...f.input,renewalReference:reference},f.container,f.arm,f.budget)).toMatchObject({status:"staged"});
  expect(f.budget.verifyImportStaging).toHaveBeenCalledWith(expect.anything(),expect.anything(),f.job,reference);expect(tail).toHaveBeenCalledOnce();
});
it("rejects a continuation execution build mismatch before dispatch",async()=>{
  const f=await tailArchive(),tail=vi.spyOn(tailOperator,"resumeArchiveTail");
  await expect(operateManagedKoho({...f.input,renewalReference:{sha256:"8".repeat(64),localCodeSha:f.input.tailRecovery.localCodeSha,executionCodeSha:"9".repeat(40)}},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(tail).not.toHaveBeenCalled();
});
async function metadataRecoveryFixture() {
  const f=await fixture(true),pkg=f.manifest.packages[0];
  const transfer=await copyManagedTransfer({sourcePath:f.sourcePath,byteLength:pkg.byteLength,sha256:pkg.sha256,acquiredAt:pkg.acquiredAt},f.path);
  const sealed=await operateManagedKoho({...f.input,sources:[{sha256:pkg.sha256,path:transfer.sourcePath}]},f.container,f.arm,f.budget);
  if(!("archive"in sealed)||!sealed.archive||!("config"in sealed)||!sealed.config||!("manifest"in sealed)||!sealed.manifest)throw Error();
  const dir=dirname(transfer.sourcePath),ownedBefore=await readFile(join(dir,"owner.json")),copiedBefore=await readFile(join(dir,"copied.json"));
  const changeCtime=async()=>{await new Promise(r=>setTimeout(r,20));const alias=join(f.path,"metadata-link");await link(transfer.sourcePath,alias);await unlink(alias);};
  await changeCtime();
  expect((await lstat(transfer.sourcePath)).ctimeMs).not.toBe(JSON.parse(copiedBefore.toString()).ctimeMs);
  const input={...f.input,command:"reconcile-transfer",transferId:transfer.transferId,sources:[],config:sealed.config,manifest:sealed.manifest,
    transferRecovery:{localCodeSha:"f".repeat(40),projectRoot:f.path}};
  return{...f,transfer,dir,ownedBefore,copiedBefore,changeCtime,input,archive:sealed.archive};
}
async function recordInterruptedMetadataRecovery(f:Awaited<ReturnType<typeof metadataRecoveryFixture>>) {
  const owner=JSON.parse(f.ownedBefore.toString()),copied=JSON.parse(f.copiedBefore.toString());
  await writeFile(join(f.dir,"metadata-reconciled.json"),JSON.stringify({schema:1,transferId:f.transfer.transferId,
    localCodeSha:f.input.transferRecovery.localCodeSha,ownerDigest:managedDigest(owner),copiedDigest:managedDigest(copied),
    archive:f.archive,sha256:owner.sha256,ctimeMs:(await lstat(f.transfer.sourcePath)).ctimeMs}),{flag:"wx"});
}
it.each(["metadata-recorded","release-recorded","zip-deleted"])("resumes metadata recovery after %s without rewriting its proof",async(point)=>{
  const f=await metadataRecoveryFixture();await recordInterruptedMetadataRecovery(f);
  const evidence=await readFile(join(f.dir,"metadata-reconciled.json"));
  if(point!=="metadata-recorded")await writeFile(join(f.dir,"release.json"),JSON.stringify({transferId:f.transfer.transferId,archive:f.archive,
    sha256:f.transfer.sha256,byteLength:f.transfer.byteLength}),{flag:"wx"});
  if(point==="zip-deleted")await unlink(f.transfer.sourcePath);
  expect((await operateManagedKoho(f.input,f.container,f.arm,f.budget)).status).toBe("released");
  expect(await readFile(join(f.dir,"metadata-reconciled.json"))).toEqual(evidence);expect(await readFile(join(f.dir,"copied.json"))).toEqual(f.copiedBefore);
  expect(await readFile(f.sourcePath)).toEqual(f.data);expect(f.arm).not.toHaveBeenCalled();
});
it.each(["ctime","local-code","archive"])("refuses changes to %s after metadata reconciliation",async(kind)=>{
  const f=await metadataRecoveryFixture();await recordInterruptedMetadataRecovery(f);
  if(kind==="ctime")await f.changeCtime();
  if(kind==="local-code")f.input.transferRecovery.localCodeSha="e".repeat(40);
  if(kind==="archive")f.files.delete(archiveReceiptName(f.config.operationId));
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect(await readFile(f.transfer.sourcePath)).toEqual(f.data);await expect(readFile(join(f.dir,"release.json"))).rejects.toMatchObject({code:"ENOENT"});
});
it("explicitly reconciles only ctime drift using historical archive proof and immutable ownership",async()=>{
  const f=await metadataRecoveryFixture(),writes=f.calls.filter(c=>c.startsWith("PUT:"));
  vi.spyOn(process,"cwd").mockReturnValue(f.path);
  await expect(operateManagedKoho({...f.input,command:"release-transfer",transferRecovery:undefined},f.container,f.arm,f.budget)).rejects.toThrow();
  expect((await operateManagedKoho(f.input,f.container,f.arm,f.budget)).status).toBe("released");
  expect(await readFile(join(f.dir,"owner.json"))).toEqual(f.ownedBefore);expect(await readFile(join(f.dir,"copied.json"))).toEqual(f.copiedBefore);
  expect(JSON.parse((await readFile(join(f.dir,"metadata-reconciled.json"))).toString())).toMatchObject({localCodeSha:"f".repeat(40),copiedDigest:managedDigest(JSON.parse(f.copiedBefore.toString()))});
  expect(await readFile(f.sourcePath)).toEqual(f.data);await expect(lstat(f.transfer.sourcePath)).rejects.toMatchObject({code:"ENOENT"});
  expect((await operateManagedKoho(f.input,f.container,f.arm,f.budget)).status).toBe("released");
  expect(f.calls.filter(c=>c.startsWith("PUT:"))).toEqual(writes);expect(f.arm).not.toHaveBeenCalled();
});
it.each(["corrupt","replacement","hardlink","mtime"])("refuses metadata recovery for %s and retains the owned file",async(kind)=>{
  const f=await metadataRecoveryFixture();
  if(kind==="corrupt"){const bad=Buffer.from(f.data);bad[0]^=1;await writeFile(f.transfer.sourcePath,bad);}
  if(kind==="replacement"){await rename(f.transfer.sourcePath,join(f.dir,"previous.zip"));await writeFile(f.transfer.sourcePath,f.data);}
  if(kind==="hardlink")await link(f.transfer.sourcePath,join(f.dir,"another-link"));
  if(kind==="mtime")await utimes(f.transfer.sourcePath,new Date(),new Date(Date.now()+10000));
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  expect((await lstat(f.transfer.sourcePath)).isFile()).toBe(true);await expect(readFile(join(f.dir,"metadata-reconciled.json"))).rejects.toMatchObject({code:"ENOENT"});
  expect(await readFile(join(f.dir,"copied.json"))).toEqual(f.copiedBefore);expect(await readFile(f.sourcePath)).toEqual(f.data);expect(f.arm).not.toHaveBeenCalled();
});
it("refuses metadata recovery when metadata changes during the full hash read",async()=>{
  const f=await metadataRecoveryFixture(),original=manualSource.verifyManualSnapshot;
  vi.spyOn(manualSource,"verifyManualSnapshot").mockImplementationOnce(async(...args)=>{await original(...args);await f.changeCtime();});
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  await expect(readFile(join(f.dir,"metadata-reconciled.json"))).rejects.toMatchObject({code:"ENOENT"});expect(await readFile(f.transfer.sourcePath)).toEqual(f.data);
});
it("requires historical budget proof and confines the local code binding to metadata recovery",async()=>{
  const f=await metadataRecoveryFixture();
  vi.mocked(f.budget.verifyArchiveRelease).mockRejectedValueOnce(Error("FICTIONAL_UNCONFIRMED_ARCHIVE"));
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();
  await expect(readFile(join(f.dir,"metadata-reconciled.json"))).rejects.toMatchObject({code:"ENOENT"});
  for(const command of ["prepare","stage","start","release-transfer","status"])await expect(operateManagedKoho({...f.input,command},f.container,f.arm,f.budget)).rejects.toThrow();
  expect(f.arm).not.toHaveBeenCalled();
});
it("continues a ready reservation after a lost reserve ACK using a new stage claim only",async()=>{
  const f=await fixture(true),reserve=vi.mocked(f.budget.reserveImport),original=reserve.getMockImplementation()!;
  reserve.mockImplementationOnce(async(...args)=>{await original(...args);throw Error("FICTIONAL_RESERVE_ACK_LOST");});
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();expect(f.budget.claimImport).not.toHaveBeenCalled();
  expect((await operateManagedKoho(f.input,f.container,f.arm,f.budget)).status).toBe("staged");expect(f.budget.claimImport).toHaveBeenCalledOnce();
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();expect(f.arm).not.toHaveBeenCalled();
});
