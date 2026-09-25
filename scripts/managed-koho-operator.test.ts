import { link, lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { AnonymousCredential, BlobServiceClient, newPipeline } from "@azure/storage-blob";
import { afterEach, expect, it, vi } from "vitest";
import { managedCloudImportFixture } from "./managed-koho-cloud.test-support";
import { operateManagedKoho, type ManagedKohoBudget } from "./managed-koho-operator";
import { cloudManifestName, cloudReceiptPrefix, cloudSourceName } from "../src/lib/koho-import/cloud-config";
import { managedImportBudgetRequest } from "../src/lib/patent-watch/managed-execution-budget";
import { managedDigest } from "../src/lib/patent-watch/managed-claims";
import { allocateManagedDownload, completeManagedDownload, copyManagedTransfer, managedTransferStatus, releaseManagedTransfer } from "./managed-koho-transfer";
import { copyManualSource } from "../src/lib/koho-import/manual-cli-source";
import { archiveReceiptName } from "../src/lib/koho-import/managed-archive";
import { runCloudImport } from "../src/lib/koho-import/cloud-runtime";
const temporary:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const path of temporary.splice(0))await rm(path,{recursive:true,force:true});});
async function fixture(archiveOnly=false){
  const f=await managedCloudImportFixture(),path=await mkdtemp(join(tmpdir(),"managed-operator-test-"));temporary.push(path);
  if(archiveOnly){f.manifest.archiveOnly=true;f.manifest.packages[0].acquiredAt=new Date(Date.now()-60_000).toISOString();
    f.policy.reservations.archivePackageYen=5;f.policy.reservations.archiveGiBYen=10;
    f.request=managedImportBudgetRequest(f.config,f.manifest,f.job,f.policy,f.binding,f.pricingDigest,null);f.config.serviceBudget!.requestDigest=f.request.requestDigest;}
  const sourcePath=join(path,"fictional.zip");await writeFile(sourcePath,f.data);
  const files=new Map<string,Buffer>([[cloudSourceName(f.manifest.packages[0].sha256),f.data]]),calls:string[]=[];
  let loseAck="",expireAfter="";
  const pipeline=newPipeline(new AnonymousCredential(),{retryOptions:{maxTries:1},httpClient:{async sendRequest(request){
    const url=new URL(request.url),name=url.pathname.slice(`/${f.config.container}/`.length),headers=request.headers.clone();
    for(const key of headers.headerNames())headers.remove(key);
    headers.set("x-ms-request-id","fictional");headers.set("x-ms-version","2025-11-05");headers.set("etag",'"sealed"');calls.push(`${request.method}:${name}`);
    let status=200,data=Buffer.alloc(0),bodyAsText:string|undefined;
    if(url.searchParams.get("restype")==="container"){}
    else if(request.method==="PUT"){
      expect(request.headers.get("if-none-match")).toBe("*");
      if(files.has(name))status=412;
      else{const body=typeof request.body==="function"?request.body():request.body;
        if(body&&typeof body==="object"&&Symbol.asyncIterator in body){const parts:Buffer[]=[];for await(const chunk of body as AsyncIterable<Uint8Array>)parts.push(Buffer.from(chunk));files.set(name,Buffer.concat(parts));}
        else files.set(name,Buffer.from(body as Uint8Array));status=201;}
      if(name===expireAfter)vi.spyOn(Date,"now").mockReturnValue(Date.parse(f.manifest.expiresAt)+1);
      if(name===loseAck)throw Error("FICTIONAL_LOST_ACK");
    } else if(!files.has(name)){
      status=404;headers.set("x-ms-error-code","BlobNotFound");headers.set("content-type","application/xml");bodyAsText='<Error><Code>BlobNotFound</Code></Error>';
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
    verifyImportStaging:vi.fn(async(c,m,j)=>{check(c,m,j);if(!reserved||start||!["claimed","done"].includes(stage))throw Error();}),
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
    lose:(name:string)=>{loseAck=name;},expire:(name:string)=>{expireAfter=name;}};
}
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
it("continues a ready reservation after a lost reserve ACK using a new stage claim only",async()=>{
  const f=await fixture(true),reserve=vi.mocked(f.budget.reserveImport),original=reserve.getMockImplementation()!;
  reserve.mockImplementationOnce(async(...args)=>{await original(...args);throw Error("FICTIONAL_RESERVE_ACK_LOST");});
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();expect(f.budget.claimImport).not.toHaveBeenCalled();
  expect((await operateManagedKoho(f.input,f.container,f.arm,f.budget)).status).toBe("staged");expect(f.budget.claimImport).toHaveBeenCalledOnce();
  await expect(operateManagedKoho(f.input,f.container,f.arm,f.budget)).rejects.toThrow();expect(f.arm).not.toHaveBeenCalled();
});
