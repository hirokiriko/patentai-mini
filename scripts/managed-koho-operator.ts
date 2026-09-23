/** Standard Local operator for the existing Job. Private input, no argv credentials. */
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { parseCloudConfiguration, parseCloudManifest, cloudManifestName, cloudSourceName, cloudReceiptPrefix, sha256, type CloudConfiguration } from "../src/lib/koho-import/cloud-config";
import { verifyManualSnapshot } from "../src/lib/koho-import/manual-cli-source";
import { managedCloudConfigSchema } from "../src/lib/patent-watch/managed-cloud-config";
import { operatorArm } from "./managed-watch-operator";
import { requireManual } from "../src/lib/koho-import/manual-cli-config";

const inputSchema=z.object({schema:z.literal(1),command:z.enum(["stage","start","status"]),config:z.unknown(),manifest:z.unknown(),
  job:z.object({resourceId:managedCloudConfigSchema.shape.jobResourceId,name:managedCloudConfigSchema.shape.jobName,image:managedCloudConfigSchema.shape.image,
    databaseSecretRef:z.string().regex(/^[a-z0-9-]{1,64}$/)}).strict(),
  sources:z.array(z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),path:z.string().max(4096).refine(isAbsolute)}).strict()).max(4).default([]),
}).strict();
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
  catch(error){if(error&&typeof error==="object"&&"statusCode"in error&&error.statusCode===404&&"code"in error&&error.code==="BlobNotFound")return null;throw error;}
}
/** A conditional marker precedes every batch of external writes. An ambiguous ACK
 * requires status/read-back, never another stage/start with a new id. */
export async function operateManagedKoho(value:unknown,container:ContainerClient,arm:Awaited<ReturnType<typeof operatorArm>>){
  const input=inputSchema.parse(value),config=parseCloudConfiguration(input.config);
  requireManual(config.approval==="STANDARD_MANAGED_WATCH_RELEASE_V1"&&input.job.resourceId.endsWith(`/jobs/${input.job.name}`));
  const bytes=Buffer.from(JSON.stringify(input.manifest)),validationConfig:CloudConfiguration={...config,manifest:{...config.manifest,sha256:sha256(bytes),byteLength:bytes.length}};
  const manifest=parseCloudManifest(bytes,validationConfig,Date.now(),input.command!=="status");
  if(input.command==="start")requireManual(sha256(bytes)===config.manifest.sha256);
  requireManual(manifest.approval==="STANDARD_MANAGED_WATCH_RELEASE_V1" && container.url===`https://${config.storageAccount}.blob.core.windows.net/${config.container}`);
  requireManual(!(await container.getProperties({abortSignal:AbortSignal.timeout(20_000)})).blobPublicAccess);
  const fresh=()=>requireManual(Date.parse(manifest.expiresAt)>Date.now()&&Date.parse(manifest.expiresAt)-Date.now()<=6*60*60_000);
  const marker=async(name:string,data:Buffer)=>{fresh();return container.getBlockBlobClient(cloudReceiptPrefix(config)+name).uploadData(data,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20_000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});};
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
  if(input.command==="stage"){
    requireManual(input.sources.length===manifest.packages.length&&new Set(input.sources.map(s=>s.sha256)).size===input.sources.length);
    for(const pkg of manifest.packages){
      const source=input.sources.find(s=>s.sha256===pkg.sha256);requireManual(source);
      const stat=await lstat(source.path);requireManual(stat.isFile()&&!stat.isSymbolicLink()&&stat.size===pkg.byteLength);
      await verifyManualSnapshot(source.path,pkg.byteLength,pkg.sha256);
    }
    await marker("staging-started.json",Buffer.from(JSON.stringify({...binding,state:"staging"})));
    for(const pkg of manifest.packages){
      const name=cloudSourceName(pkg.sha256),present=await existing(container,name);
      fresh();
      if(!present)await container.getBlockBlobClient(name).uploadFile(input.sources.find(s=>s.sha256===pkg.sha256)!.path,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(15*60_000),
        blockSize:8*1024**2,concurrency:1,blobHTTPHeaders:{blobContentType:"application/zip",blobCacheControl:"private, no-store"}});
      const saved=await existing(container,name);requireManual(saved?.contentLength===pkg.byteLength&&typeof saved.etag==="string");pkg.etag=saved.etag;
      await verifyManualSnapshot(input.sources.find(s=>s.sha256===pkg.sha256)!.path,pkg.byteLength,pkg.sha256);
    }
    fresh();
    const finalBytes=Buffer.from(JSON.stringify(manifest)),saved=await container.getBlockBlobClient(cloudManifestName(config)).uploadData(finalBytes,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20_000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});
    requireManual(saved.etag);
    const finalConfig:CloudConfiguration={...config,manifest:{sha256:sha256(finalBytes),byteLength:finalBytes.length,etag:saved.etag}};
    const reread=await container.getBlobClient(cloudManifestName(config)).downloadToBuffer(0,finalBytes.length,{conditions:{ifMatch:saved.etag},abortSignal:AbortSignal.timeout(20_000)});
    parseCloudManifest(reread,finalConfig);
    await marker("staged.json",Buffer.from(JSON.stringify({config:finalConfig,manifestDigest:sha256(finalBytes)})));
    return {status:"staged",config:finalConfig,manifest};
  }
  const beginning=await readJson(cloudReceiptPrefix(config)+"staging-started.json",65536);
  requireManual(beginning&&Object.entries(binding).every(([key,v])=>beginning.value[key]===v));
  const staged=await existing(container,cloudManifestName(config));
  requireManual(staged?.etag===config.manifest.etag&&staged.contentLength===config.manifest.byteLength);
  const savedManifest=await container.getBlobClient(cloudManifestName(config)).downloadToBuffer(0,config.manifest.byteLength,{conditions:{ifMatch:config.manifest.etag},abortSignal:AbortSignal.timeout(20_000)});
  parseCloudManifest(savedManifest,config);
  const current=await arm(`https://management.azure.com${input.job.resourceId}?api-version=2025-07-01`,"GET");
  const job=current.body as {id?:string;properties?:{environmentId?:string;configuration?:{triggerType?:string;replicaRetryLimit?:number;replicaTimeout?:number;manualTriggerConfig?:{parallelism?:number;replicaCompletionCount?:number}};template?:{containers?:Array<{name?:string;image?:string}>}}};
  const c=job?.properties?.configuration;
  requireManual(current.status===200&&job.id?.toLowerCase()===input.job.resourceId.toLowerCase()&&job.properties?.environmentId===config.expectedEnvironmentResourceId&&c?.triggerType==="Manual"&&c.replicaRetryLimit===0&&
    c.replicaTimeout!==undefined&&c.replicaTimeout<=7200&&c.replicaTimeout>=Math.ceil(manifest.maxElapsedMs/1000)&&c.manualTriggerConfig?.parallelism===1&&c.manualTriggerConfig.replicaCompletionCount===1&&
    job.properties.template?.containers?.length===1&&job.properties.template.containers[0].image===input.job.image&&/^[a-z0-9-]{1,64}$/.test(job.properties.template.containers[0].name??""));
  await marker("start-requested.json",Buffer.from(JSON.stringify({operationId:config.operationId,manifestDigest:config.manifest.sha256,jobResourceId:input.job.resourceId,image:input.job.image})));
  fresh();
  const response=await arm(`https://management.azure.com${input.job.resourceId}/start?api-version=2025-07-01`,"POST",{containers:[{name:job.properties!.template!.containers![0].name!,image:input.job.image,
    command:["node",".koho-ops/cloud/scripts/koho-cloud-import.js"],args:[],resources:{cpu:2,memory:"4Gi"},env:[{name:"KOHO_CLOUD_CONFIG_JSON",value:JSON.stringify(config)},
      ...(config.mode==="apply"?[{name:"KOHO_CLOUD_DATABASE_PASSWORD",secretRef:input.job.databaseSecretRef}]:[])]}]});
  requireManual([200,202].includes(response.status));return{status:"submitting",operationId:config.operationId};
}
if(require.main===module){
  const watchdog=setTimeout(()=>{process.stdout.write('{"status":"reconciliation_required"}\n');process.exit(2);},65*60_000);
  void(async()=>{try{
    requireManual(process.argv.length===2);let size=0;const chunks:Buffer[]=[];
    for await(const chunk of process.stdin){size+=chunk.length;requireManual(size<=256*1024);chunks.push(Buffer.from(chunk));}
    const input=inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))),config=parseCloudConfiguration(input.config);
    if(input.command!=="status")requireManual((await readFile(".managed-build-sha","utf8")).trim()===config.expectedCodeSha);
    const connection=process.env.AZURE_STORAGE_CONNECTION_STRING;requireManual(connection);
    const container=BlobServiceClient.fromConnectionString(connection,{retryOptions:{maxTries:1,tryTimeoutInMs:20_000}}).getContainerClient(config.container);
    const output=await operateManagedKoho(input,container,await operatorArm(input.job.resourceId));process.stdout.write(JSON.stringify(output)+"\n");
  }catch{process.stdout.write('{"status":"reconciliation_required"}\n');process.exitCode=2;}finally{clearTimeout(watchdog);}})();
}
