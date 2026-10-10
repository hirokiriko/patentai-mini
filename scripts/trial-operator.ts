import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile,lstat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { and,eq } from "drizzle-orm";
import { ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import * as schema from "../src/db/schema";
import { readTrialPolicy,requireTrialActive,TrialError,type TrialPolicy } from "../src/lib/trial/policy";
import { trialStorageHttp,assertTrialPrivate } from "../src/lib/trial/storage";
import { emptyTrialLedger,TrialBlobLedgerIO,TrialLedger,TRIAL_LEDGER_KEY,trialHash } from "../src/lib/trial/ledger";
import { reserveTrialDatabase } from "../src/lib/trial/database-capacity";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { ManagedDeliveryRepository } from "../src/repositories/managed-delivery";
import { ManagedPrivateStorage,reconcileManagedDelivery } from "../src/lib/patent-watch/managed-storage";
import { managedSettingSchema } from "../src/lib/patent-watch/managed-types";
import { previewManagedBase } from "./managed-base-preview";
import { verifyTrialBuild } from "../src/lib/trial/runtime";
import { prepareTrialPackage,TRIAL_PACKAGE_BYTES } from "../src/lib/trial/package";
import { saveKohoImportPlan } from "../src/repositories/drizzle";
import { trialArm,startTrialWatch } from "../src/lib/trial/job";
import type { TrialAudience } from "../src/lib/trial/identity";

const commands=z.discriminatedUnion("command",[
  z.object({command:z.literal("initialize-ledger")}).strict(),
  z.object({command:z.literal("status"),caseId:z.number().int().positive()}).strict(),
  z.object({command:z.literal("setting-save"),setting:managedSettingSchema}).strict(),
  z.object({command:z.literal("job-reconcile"),caseId:z.number().int().positive(),runId:z.uuidv4()}).strict(),
  z.object({command:z.enum(["package-preview","package-import","package-reconcile"]),sourcePath:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({command:z.literal("sample-save"),caseId:z.number().int().positive(),sourcePath:z.string().min(1),
    packageType:z.enum(["JPA","JPB"]),entryPath:z.string(),kind:z.enum(["A1","P1","B1","B2"]),publicationNumber:z.string(),
    publicationDate:z.string().regex(/^\d{8}$/),sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
  z.object({command:z.literal("delivery-reconcile"),caseId:z.number().int().positive(),deliveryId:z.uuidv4(),abandonPartial:z.boolean()}).strict(),
]);
export const trialOperatorInput=z.object({environment:z.record(z.string(),z.string()),databaseUrl:z.string(),request:commands}).strict();
const exec=promisify(execFile);
/** Local only. CLI output is consumed in memory and never forwarded or logged. */
function operatorStorageCredential(p:TrialPolicy,audience:TrialAudience="https://storage.azure.com/"){return{async getToken(){
  const result=await exec(process.platform==="win32"?"az.cmd":"az",["account","get-access-token","--resource",audience,"--output","json","--only-show-errors"],
    {windowsHide:true,shell:process.platform==="win32",timeout:30_000,maxBuffer:65536});
  const token=JSON.parse(result.stdout);
  if(typeof token.accessToken!=="string"||token.tenant?.toLowerCase()!==p.auth.tenantId.toLowerCase())throw new TrialError();
  const claims=JSON.parse(Buffer.from(token.accessToken.split(".")[1],"base64url").toString("utf8"));
  if(claims.oid?.toLowerCase()!==p.auth.ownerId.toLowerCase()||claims.tid?.toLowerCase()!==p.auth.tenantId.toLowerCase())throw new TrialError();
  return{token:token.accessToken,expiresOnTimestamp:Number(token.expires_on)*1000};
}};}
export async function runTrialOperator(value:unknown){
  const input=trialOperatorInput.parse(value),p=readTrialPolicy(input.environment);
  const allowed=new Set(["DEPLOYMENT_KIND","TRIAL_POLICY_JSON","TRIAL_POLICY_SIGNATURE","TRIAL_POLICY_PUBLIC_KEY"]);
  if(Object.keys(input.environment).some(k=>!allowed.has(k))||!p.database.migratorUser||!p.database.ownerRole)throw new TrialError();
  // This standalone Local process has one signed target; nothing is accepted from HTTP.
  for(const [k,v] of Object.entries(input.environment))process.env[k]=v;
  await verifyTrialBuild(p);
  if(input.request.command==="package-preview"){
    const source=input.request,stat=await lstat(source.sourcePath);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.size>TRIAL_PACKAGE_BYTES)throw new TrialError("trial_input_limit");
    const bytes=await readFile(source.sourcePath),pkg=await prepareTrialPackage(bytes,source.sha256);
    return{status:"previewed",sourceBytes:bytes.length,payloadBytes:pkg.payloadBytes,documents:pkg.plan.documentCount};
  }
  const url=new URL(input.databaseUrl);
  if(url.protocol!=="postgresql:"||url.hostname!==p.database.host||Number(url.port||5432)!==5432||
    decodeURIComponent(url.pathname.slice(1))!==p.database.database||decodeURIComponent(url.username)!==p.database.migratorUser||!url.password||url.search||url.hash)throw new TrialError();
  const credential=operatorStorageCredential(p);
  const container=(purpose:"originals"|"artifacts"|"budget")=>new ContainerClient(`https://${p.storage.account}.blob.core.windows.net/${p.storage[purpose]}`,credential,
    {retryOptions:{maxTries:1,tryTimeoutInMs:20000},httpClient:trialStorageHttp(purpose,p)});
  const budgetContainer=container("budget"),ledger=new TrialLedger(p,new TrialBlobLedgerIO(budgetContainer));
  if(input.request.command==="initialize-ledger"){
    requireTrialActive(p);await assertTrialPrivate(budgetContainer);
    await budgetContainer.getBlockBlobClient(TRIAL_LEDGER_KEY).uploadData(Buffer.from(JSON.stringify(emptyTrialLedger(p))),{
      conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20000),blobHTTPHeaders:{blobContentType:"application/json",blobCacheControl:"private, no-store"}});
    await ledger.read();return{status:"initialized"};
  }
  const client=new Client({connectionString:url.href,ssl:{rejectUnauthorized:true,servername:p.database.host},connectionTimeoutMillis:15000,
    statement_timeout:30000,query_timeout:35000,lock_timeout:5000,idle_in_transaction_session_timeout:30000,application_name:"trial-local-operator"});
  client.on("error",()=>undefined);
  try{
    await client.connect();
    const identity=(await client.query("select current_database() as db,current_user as usr,(select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls")).rows[0];
    if(identity.db!==p.database.database||identity.usr!==p.database.migratorUser||identity.tls!==true)throw new TrialError();
    const database=drizzle(client,{schema}),originals=container("originals");
    const readOriginal=async(caseId:number,_category:string,key:string)=>{
      if(!key.startsWith(`cases/${caseId}/prior-art/`))throw new TrialError();await assertTrialPrivate(originals);
      const blob=originals.getBlobClient(key),props=await blob.getProperties();if(!props.etag||!props.contentLength||props.contentLength>1024**2)throw new TrialError();
      return{bytes:await blob.downloadToBuffer(0,props.contentLength,{conditions:{ifMatch:props.etag}}),contentType:"application/xml"};
    };
    const watch=new ManagedWatchRepository(database,readOriginal),request=input.request;
    if("sourcePath" in request && request.command!=="sample-save"){
      const stat=await lstat(request.sourcePath);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>TRIAL_PACKAGE_BYTES)throw new TrialError("trial_input_limit");
      const bytes=await readFile(request.sourcePath),pkg=await prepareTrialPackage(bytes,request.sha256);
      if(request.command==="package-preview")return{status:"previewed",sourceBytes:bytes.length,payloadBytes:pkg.payloadBytes,documents:pkg.plan.documentCount};
      const key=`packages/${request.sha256}.zip`,blob=originals.getBlockBlobClient(key);
      const verify=async()=>{
        await assertTrialPrivate(originals);const props=await blob.getProperties();
        if(props.contentLength!==bytes.length||!props.etag)throw new TrialError();
        const stored=await blob.downloadToBuffer(0,bytes.length,{conditions:{ifMatch:props.etag}});
        if(trialHash(stored)!==request.sha256)throw new TrialError();
        await saveKohoImportPlan(database,pkg.plan,true,"reused",pkg.managed.sources,pkg.managed.receipt,true);
      };
      if(request.command==="package-reconcile"){
        const prior=await ledger.inspect(pkg.id);if(!prior||prior.intent!==pkg.intent||prior.storageKey!==key)throw new TrialError();
        await verify();await ledger.complete(pkg.id,{persisted:true,reconciled:true});
        await ledger.complete(trialHash(`database:package:${pkg.id}`),{persisted:true,reconciled:true});return{status:"verified"};
      }
      requireTrialActive(p);
      const admitted=await ledger.reserve({id:pkg.id,intent:pkg.intent,kind:"package",bytes:bytes.length,sourceBytes:bytes.length,storageKey:key});
      if(!admitted.created)throw new TrialError("trial_package_reconciliation_required");
      const capacity=await reserveTrialDatabase(database,`package:${pkg.id}`,pkg.payloadBytes,ledger);
      await ledger.claimDispatch(pkg.id);await assertTrialPrivate(originals);
      try{
        await blob.uploadData(bytes,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20000),blobHTTPHeaders:{blobContentType:"application/zip",blobCacheControl:"private, no-store"}});
        requireTrialActive(p);
        await saveKohoImportPlan(database,pkg.plan,true,"inserted",pkg.managed.sources,pkg.managed.receipt);
        await verify();await capacity.persisted();await ledger.complete(pkg.id,{persisted:true});return{status:"saved"};
      }catch{await ledger.markUnknown(pkg.id).catch(()=>undefined);throw new TrialError("trial_package_reconciliation_required");}
    }
    const caseId=request.command==="setting-save"?request.setting.caseId:request.caseId;
    const sample=p.samples.find(s=>s.caseId===caseId);if(!sample)throw new TrialError("trial_sample_not_ready");
    if(request.command==="status")return{runs:await watch.history(caseId),deliveries:await new ManagedDeliveryRepository(database).list(caseId),ledgerRevision:(await ledger.read()).state.revision};
    if(request.command==="job-reconcile")return startTrialWatch(watch,caseId,request.runId,"reconcile",ledger,trialArm(p,AbortSignal.timeout(60000),operatorStorageCredential(p,"https://management.azure.com/")));
    if(request.command==="delivery-reconcile")return{status:await reconcileManagedDelivery(new ManagedDeliveryRepository(database),new ManagedPrivateStorage(container("artifacts")),caseId,request.deliveryId,request.abandonPartial,ledger)};
    requireTrialActive(p);
    if(request.command==="setting-save"){
      if(request.setting.monitoringStartsOn!==sample.from||!request.setting.contractEndsOn||request.setting.contractEndsOn<sample.through)throw new TrialError();
      const capacity=await reserveTrialDatabase(database,`setting:${trialHash(JSON.stringify(request.setting))}`,Buffer.byteLength(JSON.stringify(request.setting))+65536,ledger);
      await watch.saveSetting(request.setting);await capacity.persisted();return{status:"saved"};
    }
    const {command:_command,caseId:_caseId,...source}=request;void _command;void _caseId;
    const preview=await previewManagedBase({...source,documentId:1}),bytes=await readFile(source.sourcePath);
    if(bytes.length>1024**2||trialHash(bytes)!==source.sha256)throw new TrialError("trial_input_limit");
    const id=trialHash(`sample:${caseId}:${source.sha256}`),key=`cases/${caseId}/prior-art/${Date.now()}-${randomUUID()}-sample.xml`;
    const admitted=await ledger.reserve({id,intent:id,kind:"storage",bytes:bytes.length,storageKey:key});
    if(!admitted.created)throw new TrialError("trial_sample_reconciliation_required");
    const capacity=await reserveTrialDatabase(database,`sample:${id}`,bytes.length+65536,ledger);
    await ledger.claimDispatch(id);await assertTrialPrivate(originals);
    try{
      await originals.getBlockBlobClient(key).uploadData(bytes,{conditions:{ifNoneMatch:"*"},abortSignal:AbortSignal.timeout(20000),
        blobHTTPHeaders:{blobContentType:"application/xml",blobCacheControl:"private, no-store"}});
      if(!bytes.equals((await readOriginal(caseId,"prior-art",key)).bytes))throw new TrialError();
      const rows=await database.select({id:schema.cases.caseId}).from(schema.cases).where(eq(schema.cases.caseId,caseId));if(rows.length!==1)throw new TrialError();
      const [row]=await database.insert(schema.priorArtDocuments).values({caseId,publicationNo:null,title:preview.base.publicationNumber,
        claimsText:bytes.toString("utf8"),sourceCsvRowJson:JSON.stringify({source:"uploaded-file",originalFileName:"sample.xml",blobName:key,contentType:"application/xml",size:bytes.length})}).returning();
      const [saved]=await database.select().from(schema.priorArtDocuments).where(and(eq(schema.priorArtDocuments.caseId,caseId),eq(schema.priorArtDocuments.docId,row.docId)));
      if(saved.claimsText!==bytes.toString("utf8"))throw new TrialError();await capacity.persisted();await ledger.complete(id,{persisted:true});
      // Returned only over the owner's private pipe; never publish this record.
      return{status:"saved",base:preview.base,source:{...preview.source,documentId:row.docId}};
    }catch{await ledger.markUnknown(id).catch(()=>undefined);throw new TrialError("trial_sample_reconciliation_required");}
  }finally{await client.end().catch(()=>undefined);}
}
if(require.main===module){
  const timer=setTimeout(()=>{process.stdout.write('{"status":"reconciliation_required"}\n');process.exit(2);},5*60_000);
  void(async()=>{try{if(process.argv.length!==2)throw Error();const parts:Buffer[]=[];let n=0;
    for await(const part of process.stdin){n+=part.length;if(n>2*1024**2)throw Error();parts.push(Buffer.from(part));}
    const result=await runTrialOperator(JSON.parse(Buffer.concat(parts).toString("utf8")));process.stdout.write(JSON.stringify(result)+"\n");
  }catch{process.stdout.write('{"status":"reconciliation_required"}\n');process.exitCode=2;}finally{clearTimeout(timer);}})();
}
