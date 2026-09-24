import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { managedCloudConfigSchema, type ManagedCloudConfiguration } from "../src/lib/patent-watch/managed-cloud-config";
import { openManagedCloudDatabase } from "../src/lib/patent-watch/managed-cloud-db";
import { dispatchManagedWatch, reconcileManagedWatchStart } from "../src/lib/patent-watch/managed-cloud-dispatch";
import { ManagedWatchRepository } from "../src/repositories/managed-watch";
import { ManagedCloudStartRepository } from "../src/repositories/managed-cloud-start";
import { ManagedDeliveryRepository } from "../src/repositories/managed-delivery";
import { ManagedRetentionRepository } from "../src/repositories/managed-retention";
import { ManagedBackupRepository } from "../src/repositories/managed-backup";
import { ManagedArchiveStorage } from "../src/lib/patent-watch/managed-archive-storage";
import { verifyManagedBackupRestore } from "./managed-watch-restore";
import { managedId, managedHash, managedSettingSchema } from "../src/lib/patent-watch/managed-types";
import { ManagedPrivateStorage, reconcileManagedDelivery } from "../src/lib/patent-watch/managed-storage";
import { ManagedServiceBudgetStorage } from "../src/lib/patent-watch/managed-service-budget-storage";
const binding=managedCloudConfigSchema.omit({operationId:true,runs:true,expiresAt:true,budgetProof:true});
const commands=z.discriminatedUnion("command",[
  z.object({command:z.literal("setting-save"),setting:managedSettingSchema}).strict(),
  z.object({command:z.literal("status"),caseId:managedId}).strict(),
  z.object({command:z.literal("finding-status"),caseId:managedId,findingId:managedId}).strict(),
  z.object({command:z.literal("finding-review"),caseId:managedId,findingId:managedId,reviewed:z.boolean(),expectedVersion:z.number().int().nonnegative().max(2147483646)}).strict(),
  z.object({command:z.literal("distribution-acquire")}).strict(),
  z.object({command:z.literal("start"),operationId:z.uuidv4(),runIds:z.array(z.uuidv4()).min(1).max(3),budgetProof:managedCloudConfigSchema.shape.budgetProof}).strict(),
  z.object({command:z.literal("start-reconcile"),operationId:z.uuidv4()}).strict(),
  z.object({command:z.literal("delivery-reconcile"),caseId:managedId,deliveryId:z.uuidv4(),abandonPartial:z.boolean().default(false)}).strict(),
  z.object({command:z.literal("backup-create"),caseId:managedId,backupId:z.uuidv4()}).strict(),
  z.object({command:z.literal("backup-reconcile"),caseId:managedId,backupId:z.uuidv4(),abandonMissing:z.boolean().default(false)}).strict(),
  z.object({command:z.literal("backup-verify-restore"),caseId:managedId,backupId:z.uuidv4()}).strict(),
  z.object({command:z.literal("deletion-preview"),caseId:managedId}).strict(),
  z.object({command:z.literal("deletion-execute"),caseId:managedId,deletionId:z.uuidv4(),manifestDigest:managedHash}).strict(),
  z.object({command:z.literal("deletion-reconcile"),caseId:managedId,deletionId:z.uuidv4(),manifestDigest:managedHash}).strict(),
]);
const requestSchema=z.object({schema:z.literal(1),binding,request:commands}).strict();
const exec=promisify(execFile);
export async function operatorArm(jobResourceId:string){
  // Official existing owner login. No credential argv, export file, raw error or stdout relay.
  const result=await exec(process.platform==="win32"?"az.cmd":"az",["account","get-access-token","--resource","https://management.azure.com/","--output","json","--only-show-errors"],
    {windowsHide:true,shell:process.platform==="win32",timeout:30_000,maxBuffer:65536});
  const parsed=JSON.parse(result.stdout),token=parsed.accessToken;
  if(typeof token!=="string"||token.length<100||token.length>32768)throw Error();
  const prefix=`https://management.azure.com${jobResourceId}`;
  return async(url:string,method:"GET"|"POST",body?:unknown)=>{
    if(!url.startsWith(prefix+"?")&&!url.startsWith(prefix+"/"))throw Error();
    const response=await fetch(url,{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:"error",signal:AbortSignal.timeout(30_000)});
    const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    try{if(reader)for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024**2)throw Error();chunks.push(value);}}
    finally{if(reader){void reader.cancel().catch(()=>undefined);reader.releaseLock();}}
    return {status:response.status,body:bytes?JSON.parse(Buffer.concat(chunks).toString("utf8")):null};
  };
}
async function readRequest(){
  let timer:ReturnType<typeof setTimeout>|undefined;
  const read=(async()=>{let bytes=0;const chunks:Buffer[]=[];for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>8*1024**2)throw Error();chunks.push(Buffer.from(chunk));}return JSON.parse(Buffer.concat(chunks).toString("utf8"));})();
  try{return requestSchema.parse(await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{process.stdin.destroy();reject(Error());},30_000);})]));}
  finally{clearTimeout(timer);}
}
if(require.main===module){
  const watchdog=setTimeout(()=>{process.stdout.write('{"status":"reconciliation_required"}\n');process.exit(2);},5*60_000);
  void(async()=>{
    let connection:Awaited<ReturnType<typeof openManagedCloudDatabase>>|undefined;
    try{
      if(process.argv.length!==2)throw Error();
      const input=await readRequest(),password=process.env.MANAGED_WATCH_DATABASE_PASSWORD;delete process.env.MANAGED_WATCH_DATABASE_PASSWORD;
      if(!password)throw Error();
      const request=input.request,b=input.binding;
      const scope=(caseId:number)=>{if(!b.caseAllowList.includes(caseId))throw Error();};
      if("caseId" in request)scope(request.caseId);if(request.command==="setting-save")scope(request.setting.caseId);
      connection=await openManagedCloudDatabase(b,password);
      const watch=new ManagedWatchRepository(connection.database),starts=new ManagedCloudStartRepository(connection.database),deliveries=new ManagedDeliveryRepository(connection.database);
      let output:unknown;
      switch(request.command){
        case "setting-save":{const setting=await watch.saveSetting(request.setting);output={status:"saved",caseId:setting.caseId};break;}
        case "status":output={runs:await watch.history(request.caseId),deliveries:await deliveries.list(request.caseId)};break;
        case "finding-status":output=await watch.findingReview(request.caseId,request.findingId);break;
        case "finding-review":await watch.reviewFinding(request.caseId,request.findingId,request.reviewed,request.expectedVersion);output={status:"saved"};break;
        case "distribution-acquire":output=await deliveries.acquireDistribution();break;
        case "start":{
          const runs:ManagedCloudConfiguration["runs"]=[];
          for(const runId of request.runIds){
            let found=false;
            for(const caseId of b.caseAllowList){
              const run=await watch.run(caseId,runId).catch(()=>null);if(run){runs.push({caseId,runId,snapshotDigest:run.snapshotDigest});found=true;break;}
            }
            if(!found)throw Error();
          }
          const budget=ManagedServiceBudgetStorage.configured();
          const config=await budget.prepareWatch({...b,operationId:request.operationId,runs,expiresAt:new Date(Date.now()+3*60*60_000).toISOString(),budgetProof:request.budgetProof});
          output=await dispatchManagedWatch(starts,config,await operatorArm(b.jobResourceId),budget);break;
        }
        case "start-reconcile":{const existing=await starts.get(request.operationId);if(existing.config.jobResourceId!==b.jobResourceId)throw Error();
          existing.config.runs.forEach(r=>scope(r.caseId));output=await reconcileManagedWatchStart(starts,request.operationId,await operatorArm(b.jobResourceId));break;}
        case "delivery-reconcile":output={status:await reconcileManagedDelivery(deliveries,ManagedPrivateStorage.configured(),request.caseId,request.deliveryId,request.abandonPartial)};break;
        case "backup-create":output=await new ManagedBackupRepository(connection.database,ManagedArchiveStorage.configured()).create(request.caseId,request.backupId);break;
        case "backup-reconcile":output=await new ManagedBackupRepository(connection.database,ManagedArchiveStorage.configured()).reconcile(request.caseId,request.backupId,request.abandonMissing);break;
        case "backup-verify-restore":{
          const saved=await new ManagedBackupRepository(connection.database,ManagedArchiveStorage.configured()).read(request.caseId,request.backupId);
          if(saved.row.status!=="stored")throw Error();
          output=await verifyManagedBackupRestore(saved.bytes,saved.row.sha256,request.caseId,request.backupId);break;
        }
        case "deletion-preview":output=await new ManagedRetentionRepository(connection.database,ManagedArchiveStorage.configured()).preview(request.caseId);break;
        case "deletion-execute":output=await new ManagedRetentionRepository(connection.database,ManagedArchiveStorage.configured()).execute(request.caseId,request.deletionId,request.manifestDigest);break;
        case "deletion-reconcile":output=await new ManagedRetentionRepository(connection.database,ManagedArchiveStorage.configured()).reconcile(request.caseId,request.deletionId,request.manifestDigest);break;
      }
      process.stdout.write(JSON.stringify(output)+"\n");process.exitCode=0;
    }catch{process.stdout.write(JSON.stringify({status:"reconciliation_required",diagnosticId:randomUUID()})+"\n");process.exitCode=2;}
    finally{await connection?.client.end().catch(()=>undefined);clearTimeout(watchdog);}
  })();
}
