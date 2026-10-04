/** Standard Local operator for the existing Job. Private input, no argv credentials. */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { parseCloudConfiguration, parseManagedCloudImportConfiguration, isManagedCloudConfiguration, isManagedCloudManifest, parseCloudManifest, cloudManifestName, cloudSourceName, cloudReceiptPrefix, sha256, type CloudConfiguration } from "../src/lib/koho-import/cloud-config";
import { verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";
import { managedCloudConfigSchema } from "../src/lib/patent-watch/managed-cloud-config";
import { operatorArm } from "./managed-watch-operator";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";
import { ManagedServiceBudgetStorage } from "../src/lib/patent-watch/managed-service-budget-storage";
import { managedBudgetBindingEnvironment } from "../src/lib/patent-watch/managed-budget-contract";
import { archiveRead, archiveReceiptName, archiveVerificationContinuationSchema, archiveVerificationRecoverySchema, confirmArchiveReceipt, readVerifiedArchive, verifyArchiveBytes } from "../src/lib/koho-import/managed-archive";
import { releaseManagedTransfer } from "./managed-koho-transfer";
import { isAzureBlobNotFound } from "../src/lib/azure-blob-errors";
import { resumeArchiveTail, tailRecoverySchema } from "./managed-koho-tail";
import { archiveRenewalInputSchema, archiveRenewalReferenceSchema } from "../src/lib/koho-import/archive-expiry-renewal";

const inputSchema=z.object({schema:z.literal(1),command:z.enum(["prepare","stage","reconcile-stage","recover-archive-upload","recover-archive-tail","renew-archive-expiry","release-transfer","reconcile-transfer","start","status"]),config:z.unknown(),manifest:z.unknown(),
  job:z.object({resourceId:managedCloudConfigSchema.shape.jobResourceId,name:managedCloudConfigSchema.shape.jobName,image:managedCloudConfigSchema.shape.image,
    databaseSecretRef:z.string().regex(/^[a-z0-9-]{1,64}$/)}).strict(),
  sources:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().max(4096).refine(isAbsolute)}).strict()).max(4).default([]),
  transferId:z.uuidv4().optional(),
  transferRecovery:z.object({localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),projectRoot:z.string().max(4096).refine(isAbsolute)}).strict().optional(),
  uploadRecovery:z.object({localCodeSha:z.string().regex(/^[a-f0-9]{40}$/),ownerApprovalSha256:z.string().regex(/^[a-f0-9]{64}$/),
    priorFailureSha256:z.string().regex(/^[a-f0-9]{64}$/),priorSenderTerminated:z.literal(true),maxUploadElapsedMs:z.number().int().positive()}).strict().optional(),
  tailRecovery:tailRecoverySchema.optional(),
  expiryRenewal:archiveRenewalInputSchema.optional(),renewalReference:archiveRenewalReferenceSchema.optional(),
  verificationContinuation:archiveVerificationContinuationSchema.optional(),
  verificationRecovery:archiveVerificationRecoverySchema.optional(),
}).strict().refine(v=>(v.command==="reconcile-transfer")===(v.transferRecovery!==undefined))
  .refine(v=>(v.command==="recover-archive-upload")===(v.uploadRecovery!==undefined))
  .refine(v=>(v.command==="recover-archive-tail")===(v.tailRecovery!==undefined))
  .refine(v=>(v.command==="renew-archive-expiry")===(v.expiryRenewal!==undefined))
  .refine(v=>!v.renewalReference||["recover-archive-tail","reconcile-stage"].includes(v.command))
  .refine(v=>!v.tailRecovery||!v.renewalReference||v.tailRecovery.localCodeSha===(v.renewalReference.executionCodeSha??v.renewalReference.localCodeSha))
  .refine(v=>!v.verificationContinuation||(v.command==="reconcile-stage"&&(!v.renewalReference||v.verificationContinuation.localCodeSha===(v.renewalReference.executionCodeSha??v.renewalReference.localCodeSha))))
  .refine(v=>!v.verificationRecovery||(!v.verificationContinuation&&v.command==="reconcile-stage"&&(!v.renewalReference||v.verificationRecovery.localCodeSha===(v.renewalReference.executionCodeSha??v.renewalReference.localCodeSha))));
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value&&typeof value==="object")return `{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function approvalDigest(manifest:ReturnType<typeof parseCloudManifest>) {
  return sha256(canonical({...manifest,packages:manifest.packages.map(pkg=>({...pkg,etag:null}))}));
}
function configurationDigest(config:CloudConfiguration){return sha256(canonical({...config,manifest:null}));}
async function existing(container:ContainerClient,name:string){
  try{return await container.getBlobClient(name).getProperties({abortSignal:AbortSignal.timeout(20_000)});}
  catch(error){if(isAzureBlobNotFound(error))return null;throw error;}
}
/** A conditional marker precedes every batch of external writes. A ready
 * reservation can receive its first fresh stage claim; claimed writes cannot replay. */
export type ManagedKohoBudget = Pick<ManagedServiceBudgetStorage,"prepareImport"|"reserveImport"|"claimImport"|"confirmImport"|"verifyImportStaging"|"verifyArchiveRelease"|"markUnknown"> & Partial<Pick<ManagedServiceBudgetStorage,"renewArchiveStaging">>;
export async function operateManagedKoho(value:unknown,container:ContainerClient,arm:Awaited<ReturnType<typeof operatorArm>>,budgetDependency?:ManagedKohoBudget){
  const input=inputSchema.parse(value),config=input.command==="status"||input.command==="prepare"?parseCloudConfiguration(input.config):parseManagedCloudImportConfiguration(input.config);
  requireManual(isManagedCloudConfiguration(config)&&input.job.resourceId.endsWith(`/jobs/${input.job.name}`));
  const bytes=Buffer.from(JSON.stringify(input.manifest)),validationConfig:CloudConfiguration={...config,manifest:{...config.manifest,sha256:sha256(bytes),byteLength:bytes.length}};
  const manifest=parseCloudManifest(bytes,validationConfig,Date.now(),!input.renewalReference&&!["status","release-transfer","reconcile-transfer","renew-archive-expiry"].includes(input.command));
  if(input.command==="start")requireManual(sha256(bytes)===config.manifest.sha256);
  requireManual(isManagedCloudManifest(manifest) && container.url===`https://${config.storageAccount}.blob.core.windows.net/${config.container}`);
  if(input.command==="start")requireManual(!manifest.archiveOnly);
  if(input.command==="prepare")return{status:"prepared",config:await (budgetDependency??ManagedServiceBudgetStorage.configured()).prepareImport(config,manifest,input.job),manifest};
  requireManual(!(await container.getProperties({abortSignal:AbortSignal.timeout(20_000)})).blobPublicAccess);
  if(input.command==="release-transfer"||input.command==="reconcile-transfer"){
    requireManual(manifest.archiveOnly&&input.transferId&&input.sources.length===0&&sha256(bytes)===config.manifest.sha256);
    const receipt=await archiveRead(container,archiveReceiptName(config.operationId));requireManual(receipt);
    await (budgetDependency??ManagedServiceBudgetStorage.configured()).verifyArchiveRelease(config,manifest,sha256(receipt.data));
    return releaseManagedTransfer({transferId:input.transferId,config,package:{...manifest.packages[0],archive:{operationId:config.operationId,
      manifestSha256:config.manifest.sha256,receiptSha256:sha256(receipt.data)}},metadataRecoveryCodeSha:input.transferRecovery?.localCodeSha},container,input.transferRecovery?.projectRoot);
  }
  let effectiveExpiry=manifest.expiresAt;
  const fresh=()=>requireManual(Date.parse(effectiveExpiry)>Date.now()&&Date.parse(effectiveExpiry)-Date.now()<=6*60*60_000);
  const marker=async(name:string,data:Buffer,signal?:AbortSignal)=>{fresh();return container.getBlockBlobClient(cloudReceiptPrefix(config)+name).uploadData(data,{conditions:{ifNoneMatch:"*"},abortSignal:signal??AbortSignal.timeout(20_000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});};
  const binding={operationId:config.operationId,approvalDigest:approvalDigest(manifest),configurationDigest:configurationDigest(config),jobDigest:sha256(canonical(input.job))};
  const readJson=async(name:string,maxBytes=131072)=>{
    const props=await existing(container,name);if(!props)return null;
    requireManual(props.etag&&props.contentLength!==undefined&&props.contentLength>0&&props.contentLength<=maxBytes);
    const data=await container.getBlobClient(name).downloadToBuffer(0,props.contentLength,{conditions:{ifMatch:props.etag},abortSignal:AbortSignal.timeout(20_000)});
    return{data,props,value:JSON.parse(data.toString("utf8"))};
  };
  if(input.command==="status"){
    const beginning=await readJson(cloudReceiptPrefix(config)+"staging-started.json",65536);
    if(!beginning)return{status:"not_staged",operationId:config.operationId};
    requireManual(Object.entries(binding).every(([key,v])=>beginning.value[key]===v));
    const saved=await readJson(cloudManifestName(config));
    if(!saved)return{status:"reconciliation_required",stage:"partial",operationId:config.operationId};
    const sealedConfig:CloudConfiguration={...config,manifest:{sha256:sha256(saved.data),etag:saved.props.etag!,byteLength:saved.data.length}};
    const sealedManifest=parseCloudManifest(saved.data,sealedConfig,Date.now(),false);
    requireManual(approvalDigest(sealedManifest)===binding.approvalDigest);
    const completedStage=await readJson(cloudReceiptPrefix(config)+"staged.json",65536);
    if(completedStage)requireManual(canonical(completedStage.value.config)===canonical(sealedConfig)&&completedStage.value.manifestDigest===sealedConfig.manifest.sha256);
    const requested=await readJson(cloudReceiptPrefix(config)+"start-requested.json",65536);
    if(!requested)return{status:"staged",config:sealedConfig,manifest:sealedManifest};
    requireManual(requested.value.operationId===config.operationId&&requested.value.manifestDigest===sealedConfig.manifest.sha256&&requested.value.jobResourceId===input.job.resourceId&&requested.value.image===input.job.image);
    const finished=await readJson(cloudReceiptPrefix(config)+"finished.json",65536);
    if(!finished)return{status:"reconciliation_required",stage:"start_requested",operationId:config.operationId,config:sealedConfig,manifest:sealedManifest};
    const report=finished.value;requireManual(report.operationId===config.operationId&&report.manifestSha256===sealedConfig.manifest.sha256&&report.codeSha===config.expectedCodeSha);
    return{status:report.status==="complete"?"complete":"reconciliation_required",cleanup:report.cleanup==="complete"?"complete":"required",capacityConfirmed:report.capacityConfirmed===true,
      databaseGrowthBytes:Number.isSafeInteger(report.databaseGrowthBytes)?report.databaseGrowthBytes:null};
  }
  const budget=budgetDependency??ManagedServiceBudgetStorage.configured();
  if(input.command==="renew-archive-expiry"){
    requireManual(manifest.archiveOnly&&manifest.packages.length===1&&!manifest.packages[0].archive&&input.sources.length===0&&budget.renewArchiveStaging);
    const beginning=await readJson(cloudReceiptPrefix(config)+"staging-started.json",65536);
    requireManual(beginning&&Object.entries(binding).every(([key,v])=>beginning.value[key]===v));
    return{status:"expiry_renewed",...await budget.renewArchiveStaging(config,manifest,input.job,input.expiryRenewal)};
  }
  if(input.command==="stage"||input.command==="reconcile-stage"||input.command==="recover-archive-upload"||input.command==="recover-archive-tail"){
    const reconcile=input.command==="reconcile-stage",recover=input.command==="recover-archive-upload",tail=input.command==="recover-archive-tail",fromArchives=manifest.packages.every(p=>p.archive);
    if(reconcile)requireManual(manifest.archiveOnly||fromArchives);
    if(input.verificationContinuation||input.verificationRecovery)requireManual(manifest.archiveOnly&&manifest.packages.length===1&&!fromArchives);
    if(input.verificationRecovery)requireManual(input.verificationRecovery.maxElapsedMs+60_000<manifest.maxElapsedMs);
    if(recover)requireManual(manifest.archiveOnly&&manifest.packages.length===1&&!fromArchives&&
      input.uploadRecovery!.maxUploadElapsedMs+15*60_000<manifest.maxElapsedMs);
    if(tail)requireManual(manifest.archiveOnly&&manifest.packages.length===1&&!fromArchives&&
      input.tailRecovery!.maxUploadElapsedMs+15*60_000<manifest.maxElapsedMs);
    requireManual(input.sources.length===(reconcile||fromArchives?0:manifest.packages.length)&&new Set(input.sources.map(s=>s.sha256)).size===input.sources.length);
    if(!reconcile&&!fromArchives)for(const pkg of manifest.packages){
      const source=input.sources.find(s=>s.sha256===pkg.sha256);requireManual(source);
      const stat=await lstat(source.path);requireManual(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===pkg.byteLength);
      await verifyManualSnapshot(source.path,pkg.byteLength,pkg.sha256);
    }
    if(reconcile||recover||tail){
      const beginning=await readJson(cloudReceiptPrefix(config)+"staging-started.json",65536);
      requireManual(beginning&&Object.entries(binding).every(([key,v])=>beginning.value[key]===v));
      const permit=await budget.verifyImportStaging(config,manifest,input.job,input.renewalReference);
      if(input.renewalReference){requireManual(manifest.archiveOnly&&permit&&permit.sha256===input.renewalReference.sha256);effectiveExpiry=permit.expiresAt;fresh();}
      if(input.verificationRecovery)requireManual(Date.now()+input.verificationRecovery.maxElapsedMs+60_000<Date.parse(effectiveExpiry));
    }else{
      await budget.reserveImport(config,manifest,input.job);
      // A lost reserve ACK may have left stage=ready, before any upload. Only a
      // new successful stage CAS grants permission; claimed/done still reject.
      await budget.claimImport(config,manifest,input.job,"stage");
      await marker("staging-started.json",Buffer.from(JSON.stringify({...binding,state:"staging"})));
    }
    if(recover||tail){
      // Each recovery marker has one winner. Tail recovery spends only the
      // proven remainder of the prior upload allowance. Historical intents and
      // budget claims remain unchanged; committed content uses reconcile-stage.
      for(const name of [cloudSourceName(manifest.packages[0].sha256),cloudManifestName(config),
        archiveReceiptName(config.operationId),...['start-requested.json','staged.json',
          'archive-verification-started.json','archive-verification-recovery-started.json'].map(n=>cloudReceiptPrefix(config)+n)])
        requireManual(!await existing(container,name));
      requireManual(Date.now()+manifest.maxElapsedMs<Date.parse(effectiveExpiry));
      if(recover)await marker("upload-recovery-started.json",Buffer.from(JSON.stringify({...binding,...input.uploadRecovery,
        sourceSha256:manifest.packages[0].sha256,sourceBytes:manifest.packages[0].byteLength})));
      else{
        const previous=await readJson(cloudReceiptPrefix(config)+"upload-recovery-started.json",65536),pkg=manifest.packages[0];
        requireManual(previous&&previous.props.lastModified&&Object.entries(binding).every(([key,v])=>previous.value[key]===v)&&
          previous.value.sourceSha256===pkg.sha256&&previous.value.sourceBytes===pkg.byteLength);
        await resumeArchiveTail({recovery:input.tailRecovery!,sourcePath:input.sources[0].path,sourceBytes:pkg.byteLength,
          blob:container.getBlockBlobClient(cloudSourceName(pkg.sha256)),previous:{data:previous.data,lastModified:previous.props.lastModified,
            maxUploadElapsedMs:previous.value.maxUploadElapsedMs,ownerApprovalSha256:previous.value.ownerApprovalSha256},guard:fresh,
          createMarker:(data,signal)=>marker("upload-tail-started.json",Buffer.from(JSON.stringify({...binding,...JSON.parse(data.toString("utf8"))})),signal)});
      }
    }
    let archiveReceiptSha256:string|undefined;
    for(const pkg of manifest.packages){
      if(pkg.archive){await readVerifiedArchive(container,config,pkg);continue;}
      const name=cloudSourceName(pkg.sha256),present=await existing(container,name);
      fresh();
      if(reconcile)requireManual(present); // Never replay an ambiguous ZIP upload.
      if(recover)requireManual(!present);
      if(tail)requireManual(present);
      // Full upload uses a new SDK prefix. Tail recovery already conditionally
      // committed its reconciled prefix; both paths still require full SHA QA.
      if(!present)await container.getBlockBlobClient(name).uploadFile(input.sources.find(s=>s.sha256===pkg.sha256)!.path,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(input.uploadRecovery?.maxUploadElapsedMs??15*60_000),
        blockSize:8*1024**2,concurrency:1,blobHTTPHeaders:{blobContentType:"application/zip",blobCacheControl:"private, no-store"}});
      const saved=await existing(container,name);requireManual(saved?.contentLength===pkg.byteLength&&typeof saved.etag==="string");pkg.etag=saved.etag;
      if(!manifest.archiveOnly)await verifyArchiveBytes(container,pkg);fresh();
      if(!reconcile)await verifyManualSnapshot(input.sources.find(s=>s.sha256===pkg.sha256)!.path,pkg.byteLength,pkg.sha256);
      if(manifest.archiveOnly)archiveReceiptSha256=await confirmArchiveReceipt(container,config,pkg,reconcile,fresh,input.verificationContinuation,input.verificationRecovery);
    }
    fresh();
    const finalBytes=Buffer.from(JSON.stringify(manifest));
    let stored=await archiveRead(container,cloudManifestName(config));
    if(!stored){await container.getBlockBlobClient(cloudManifestName(config)).uploadData(finalBytes,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20_000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});
      stored=await archiveRead(container,cloudManifestName(config));}
    requireManual(stored&&stored.data.equals(finalBytes));
    const finalConfig:CloudConfiguration={...config,manifest:{sha256:sha256(finalBytes),byteLength:finalBytes.length,etag:stored.props.etag!}};
    parseCloudManifest(stored.data,finalConfig,Date.now(),!input.renewalReference);fresh();
    const stageRecord={config:finalConfig,manifestDigest:sha256(finalBytes)};
    const previous=await readJson(cloudReceiptPrefix(config)+"staged.json",65536);
    if(previous)requireManual(canonical(previous.value)===canonical(stageRecord));
    else await marker("staged.json",Buffer.from(JSON.stringify(stageRecord)));
    await budget.confirmImport(finalConfig,manifest,input.job,input.renewalReference);
    return {status:"staged",config:finalConfig,manifest,...(archiveReceiptSha256?{archive:{operationId:config.operationId,manifestSha256:finalConfig.manifest.sha256,receiptSha256:archiveReceiptSha256}}:{})};
  }
  const beginning=await readJson(cloudReceiptPrefix(config)+"staging-started.json",65536);
  requireManual(beginning&&Object.entries(binding).every(([key,v])=>beginning.value[key]===v));
  const staged=await existing(container,cloudManifestName(config));
  requireManual(staged?.etag===config.manifest.etag&&staged.contentLength===config.manifest.byteLength);
  const savedManifest=await container.getBlobClient(cloudManifestName(config)).downloadToBuffer(0,config.manifest.byteLength,{conditions:{ifMatch:config.manifest.etag},abortSignal:AbortSignal.timeout(20_000)});
  const verifiedManifest=parseCloudManifest(savedManifest,config);
  const current=await arm(`https://management.azure.com${input.job.resourceId}?api-version=2025-07-01`,"GET");
  const job=current.body as {id?:string;properties?:{environmentId?:string;configuration?:{triggerType?:string;replicaRetryLimit?:number;replicaTimeout?:number;manualTriggerConfig?:{parallelism?:number;replicaCompletionCount?:number}};template?:{containers?:Array<{name?:string;image?:string}>;initContainers?:unknown}}};
  const c=job?.properties?.configuration;
  requireManual(current.status===200&&job.id?.toLowerCase()===input.job.resourceId.toLowerCase()&&job.properties?.environmentId===config.expectedEnvironmentResourceId&&c?.triggerType==="Manual"&&c.replicaRetryLimit===0&&
    c.replicaTimeout!==undefined&&c.replicaTimeout<=7200&&c.replicaTimeout>=Math.ceil(manifest.maxElapsedMs/1000)&&c.manualTriggerConfig?.parallelism===1&&c.manualTriggerConfig.replicaCompletionCount===1&&
    job.properties.template?.containers?.length===1&&job.properties.template.containers[0].image===input.job.image&&/^[a-z0-9-]{1,64}$/.test(job.properties.template.containers[0].name??""));
  const init=job.properties!.template!.initContainers;requireManual(init===undefined||init===null||(Array.isArray(init)&&init.length===0));
  // Explicit start can finish a lost stage-confirmation ACK from sealed content;
  // status never writes the budget or creates permission to submit a Job.
  await budget.confirmImport(config,verifiedManifest,input.job);
  await budget.claimImport(config,verifiedManifest,input.job,"start");
  await marker("start-requested.json",Buffer.from(JSON.stringify({operationId:config.operationId,manifestDigest:config.manifest.sha256,jobResourceId:input.job.resourceId,image:input.job.image})));
  fresh();
  const managedConfig=parseManagedCloudImportConfiguration(config);
  try{const response=await arm(`https://management.azure.com${input.job.resourceId}/start?api-version=2025-07-01`,"POST",{containers:[{name:job.properties!.template!.containers![0].name!,image:input.job.image,
    // Keep native allocations outside the bounded V8 heap within the same 4-GiB worker.
    command:["node","--max-old-space-size=3072",".koho-ops/cloud/scripts/koho-cloud-import.js"],args:[],resources:{cpu:2,memory:"4Gi"},env:[{name:"KOHO_CLOUD_CONFIG_JSON",value:JSON.stringify(config)},
      {name:"MANAGED_IMPORT_JOB_JSON",value:JSON.stringify(input.job)},...managedBudgetBindingEnvironment(managedConfig.budgetBinding),
      ...(config.mode==="apply"?[{name:"KOHO_CLOUD_DATABASE_PASSWORD",secretRef:input.job.databaseSecretRef}]:[])]}],initContainers:[]});
  requireManual([200,202].includes(response.status));return{status:"submitting",operationId:config.operationId};
  }catch{await budget.markUnknown(config.operationId).catch(()=>undefined);throw Error("cloud_start_unknown");}
}
if(require.main===module){
  const watchdog=setTimeout(()=>{process.stdout.write('{"status":"reconciliation_required"}\n');process.exit(2);},65*60_000);
  void(async()=>{try{
    requireManual(process.argv.length===2);let size=0;const chunks:Buffer[]=[];
    for await(const chunk of process.stdin){size+=chunk.length;requireManual(size<=256*1024);chunks.push(Buffer.from(chunk));}
    const input=inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),config=parseCloudConfiguration(input.config);
    if(input.command!=="status")requireManual((await readFile(".managed-build-sha","utf8")).trim()===(input.transferRecovery?.localCodeSha??input.uploadRecovery?.localCodeSha??input.tailRecovery?.localCodeSha??input.expiryRenewal?.localCodeSha??input.verificationRecovery?.localCodeSha??input.verificationContinuation?.localCodeSha??input.renewalReference?.executionCodeSha??input.renewalReference?.localCodeSha??config.expectedCodeSha));
    const connection=process.env.AZURE_STORAGE_CONNECTION_STRING;requireManual(connection);
    const container=BlobServiceClient.fromConnectionString(connection,{retryOptions:{maxTries:1,tryTimeoutInMs:20_000}}).getContainerClient(config.container);
    const output=await operateManagedKoho(input,container,await operatorArm(input.job.resourceId));process.stdout.write(JSON.stringify(output)+"\n");
  }catch{process.stdout.write('{"status":"reconciliation_required"}\n');process.exitCode=2;}finally{clearTimeout(watchdog);}})();
}
