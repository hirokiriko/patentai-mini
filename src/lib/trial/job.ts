import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { ManagedWatchRepository } from "../../repositories/managed-watch";
import { managedAzureAnalysis, validateManagedScreening } from "../patent-watch/managed-service";
import { managedDigest } from "../patent-watch/managed-claims";
import { managedScreeningInput } from "../patent-watch/managed-types";
import type { ManagedRun } from "../patent-watch/managed-types";
import { withTrialAiBudget, type ManagedWatchDispatchJournal } from "../ai-operation-budget";
import { readTrialPolicy, requireTrialActive, trialPolicyDigest, TrialError, type TrialPolicy } from "./policy";
import { TrialLedger, trialHash, trialCallYen } from "./ledger";
import { trialIdentity } from "./identity";
import { verifyTrialBuild } from "./runtime";
export { verifyTrialBuild } from "./runtime";

export const trialJobRequestSchema = z.object({ schema:z.literal(1),kind:z.literal("trial-watch"),
  caseId:z.number().int().positive(),runId:z.uuidv4(),snapshotDigest:z.string().regex(/^[a-f0-9]{64}$/),
  policyDigest:z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type TrialJobRequest = z.infer<typeof trialJobRequestSchema>;
const VERSION = "2025-07-01";
export type TrialArm = (suffix: string, method:"GET" | "POST", body?:unknown) => Promise<{status:number;body:unknown}>;
export function trialArm(p: TrialPolicy, signal: AbortSignal, identity=trialIdentity(p,"web","https://management.azure.com/")): TrialArm {
  return async (suffix,method,body) => {
    if ((suffix === "/start") !== (method === "POST") || !["","/start","/executions"].includes(suffix)&&!/^\/executions\/[a-z0-9-]{1,100}$/.test(suffix)) throw new TrialError();
    const token = await identity.getToken();
    if (method === "POST") { requireTrialActive(p); if (trialPolicyDigest(readTrialPolicy()) !== trialPolicyDigest(p)) throw new TrialError(); }
    const response = await fetch(`https://management.azure.com${p.jobResourceId}${suffix}?api-version=${VERSION}`, {
      method,headers:{Authorization:`Bearer ${token.token}`,"Content-Type":"application/json"},redirect:"error",
      signal:AbortSignal.any([signal,AbortSignal.timeout(30_000)]),...(body === undefined ? {} : {body:JSON.stringify(body)}) });
    const reader = response.body?.getReader(), parts:Uint8Array[]=[]; let size=0;
    try { if (reader) for (;;) { const r=await reader.read(); if(r.done)break; size+=r.value.length;
      if(size>1024**2)throw new TrialError(); parts.push(r.value); } }
    finally { if(reader){await reader.cancel().catch(()=>undefined);reader.releaseLock();} }
    return {status:response.status,body:size?JSON.parse(Buffer.concat(parts).toString("utf8")):null};
  };
}
const optionalText=z.string().nullish().transform(v=>v??undefined);
const envSchema = z.object({name:z.string(),value:optionalText,secretRef:optionalText}).strict().refine(v=>!(v.value!==undefined&&v.secretRef!==undefined));
const containerSchema = z.object({name:z.string(),image:z.string(),command:z.array(z.string()),args:z.array(z.string()).nullish(),
  resources:z.object({cpu:z.number(),memory:z.string()}).passthrough(),env:z.array(envSchema)}).passthrough();
export function trialJobTemplate(value:unknown,p:TrialPolicy,request:TrialJobRequest) {
  const job = z.object({id:z.string(),properties:z.object({environmentId:z.string(),configuration:z.object({triggerType:z.literal("Manual"),
    replicaTimeout:z.literal(1800),replicaRetryLimit:z.literal(0),manualTriggerConfig:z.object({parallelism:z.literal(1),replicaCompletionCount:z.literal(1)}).passthrough()}).passthrough(),
    template:z.object({containers:z.array(containerSchema).length(1),initContainers:z.array(z.unknown()).max(0).nullish()}).passthrough()}).passthrough()}).passthrough().parse(value);
  const c=job.properties.template.containers[0], env=c.env;
  const get=(name:string)=>env.find(e=>e.name===name);
  if(job.id.toLowerCase()!==p.jobResourceId.toLowerCase()||job.properties.environmentId.toLowerCase()!==p.environmentResourceId.toLowerCase()||
    c.image!==p.image||c.resources.cpu!==2||c.resources.memory!=="4Gi"||JSON.stringify(c.command)!==JSON.stringify(["node",".koho-ops/managed/scripts/trial-watch-worker.js"])||
    (c.args?.length??0)!==0||new Set(env.map(e=>e.name)).size!==env.length||
    get("DEPLOYMENT_KIND")?.value!=="trial"||get("TRIAL_RUNTIME_ROLE")?.value!=="worker"||get("AI_PROVIDER")?.value!=="azure"||
    get("TRIAL_POLICY_JSON")?.value!==process.env.TRIAL_POLICY_JSON||get("TRIAL_POLICY_SIGNATURE")?.value!==process.env.TRIAL_POLICY_SIGNATURE||
    get("TRIAL_POLICY_PUBLIC_KEY")?.value!==process.env.TRIAL_POLICY_PUBLIC_KEY||get("DATABASE_URL")?.secretRef!=="trial-worker-database"||
    env.some(e=>!["DEPLOYMENT_KIND","TRIAL_RUNTIME_ROLE","AI_PROVIDER","TRIAL_POLICY_JSON","TRIAL_POLICY_SIGNATURE","TRIAL_POLICY_PUBLIC_KEY","DATABASE_URL"].includes(e.name)))
    throw new TrialError("trial_job_mismatch");
  return {containers:[{name:c.name,image:c.image,command:c.command,args:[],resources:{cpu:2,memory:"4Gi"},
    env:[...env,{name:"TRIAL_EXECUTION_JSON",value:JSON.stringify(request)}]}],initContainers:[]};
}
export async function startTrialWatch(repository: ManagedWatchRepository, caseId:number,runId:string,action:"start"|"reconcile",
  ledger:TrialLedger,arm:TrialArm) {
  const p=ledger.policy; if(action==="start")requireTrialActive(p);
  if(!p.samples.some(s=>s.caseId===caseId))throw new TrialError("trial_sample_not_ready");
  const run=await repository.run(caseId,runId);
  const request=trialJobRequestSchema.parse({schema:1,kind:"trial-watch",caseId,runId,snapshotDigest:run.snapshotDigest,policyDigest:trialPolicyDigest(p)});
  const id=trialHash(runId), prior=await ledger.inspect(id);
  if(prior) {
    if(action==="reconcile")return reconcileTrialWatch(repository,request,ledger,arm);
    return {operationId:runId,status:trialPublicStatus(prior.status)}; // Never retry an uncertain ARM start.
  }
  if(action==="reconcile")return {operationId:runId,status:"not_started"};
  if(run.status!=="prepared")throw new TrialError("trial_run_unavailable");
  const response=await arm("","GET"); if(response.status!==200)throw new TrialError("trial_job_unavailable");
  const template=trialJobTemplate(response.body,p,request);
  const reserved=await ledger.reserve({id,intent:trialHash(JSON.stringify(request)),kind:"compare",noAi:run.snapshot.candidates.length===0});
  if(!reserved.created)return {operationId:runId,status:reserved.operation.status};
  await ledger.claimDispatch(id);
  try {
    const started=await arm("/start","POST",template);
    const result=z.object({name:z.string(),id:z.string()}).passthrough().parse(started.body);
    if(![200,202].includes(started.status)||!result.name.startsWith(p.jobResourceId.split("/").pop()+"-")||
      !/^[a-z0-9-]{1,100}$/.test(result.name)||result.id.toLowerCase()!==`${p.jobResourceId}/executions/${result.name}`.toLowerCase())throw new TrialError();
    await ledger.recordExecution(id,result.name);return {operationId:runId,status:"accepted"};
  } catch { await ledger.markUnknown(id,true).catch(()=>undefined); return {operationId:runId,status:"outcome_unknown"}; }
}
export async function reconcileTrialWatch(repository:ManagedWatchRepository,request:TrialJobRequest,ledger:TrialLedger,arm:TrialArm){
  const p=ledger.policy,id=trialHash(request.runId),o=await ledger.inspect(id);if(!o)throw new TrialError();
  let execution=o.execution??o.receiptExecution;
  const match=(value:unknown)=>{
    const parsed=z.object({id:z.string(),name:z.string(),properties:z.object({status:z.string(),startTime:z.string().optional(),endTime:z.string().optional(),
      template:z.object({containers:z.array(containerSchema).length(1)}).passthrough()}).passthrough()}).passthrough().parse(value);
    const c=parsed.properties.template.containers[0],raw=c.env.find(e=>e.name==="TRIAL_EXECUTION_JSON")?.value;
    if(parsed.id.toLowerCase()!==`${p.jobResourceId}/executions/${parsed.name}`.toLowerCase()||c.image!==o.image||!raw||
      trialHash(JSON.stringify(trialJobRequestSchema.parse(JSON.parse(raw))))!==o.intent)throw new TrialError("trial_execution_mismatch");
    return parsed;
  };
  if(!execution){
    const result=await arm("/executions","GET"),list=z.object({value:z.array(z.unknown()).max(50),nextLink:z.string().optional()}).passthrough().parse(result.body);
    if(result.status!==200||list.nextLink)throw new TrialError("trial_reconciliation_incomplete");
    const matches=list.value.flatMap(v=>{try{return[match(v)];}catch{return[];}});
    if(matches.length>1)throw new TrialError("trial_reconciliation_incomplete");
    if(matches.length===1){execution=matches[0].name;await ledger.recordExecution(id,execution);}
  }
  if(!execution)return {operationId:request.runId,status:trialPublicStatus(o.status),executionStatus:"Unknown"};
  const result=await arm(`/executions/${execution}`,"GET");if(result.status!==200)throw new TrialError();
  const observed=match(result.body),state=observed.properties;
  if(observed.name!==execution)throw new TrialError();
  if(["Succeeded","Failed","Stopped"].includes(state.status)){
    const run=await repository.run(request.caseId,request.runId);
    if(run.snapshotDigest!==request.snapshotDigest)throw new TrialError();
    if(run.status==="prepared")await repository.failUnstartedTrial(request.caseId,request.runId,request.snapshotDigest);
    if(run.status==="running"&&run.executionId===execution)await repository.fail(run,await repository.hasUnknownDispatch(run));
    const current=await repository.run(request.caseId,request.runId);
    const seconds=state.startTime&&state.endTime?Math.ceil((Date.parse(state.endTime)-Date.parse(state.startTime))/1000):1800;
    await ledger.reconcileTerminalJob(id,{execution,seconds,databaseConfirmed:["completed","failed","unknown"].includes(current.status)&&
      (current.executionId===execution||current.executionId===null)});
  }
  return {operationId:request.runId,status:trialPublicStatus((await ledger.inspect(id))!.status),executionStatus:state.status};
}
function trialPublicStatus(status:string){return ({complete:"completed",reserved:"budget_reserved",unknown:"outcome_unknown",dispatching:"outcome_unknown",running:"accepted"} as Record<string,string>)[status]??"outcome_unknown";}
export async function webTrialWatch(db:NodePgDatabase<typeof schema>,caseId:number,runId:string,action:"start"|"reconcile",signal:AbortSignal) {
  const p=readTrialPolicy(); await verifyTrialBuild(p);
  return startTrialWatch(new ManagedWatchRepository(db),caseId,runId,action,TrialLedger.configured(),trialArm(p,signal));
}
export async function executeTrialWatch(repository:ManagedWatchRepository,request:TrialJobRequest,execution:string,ledger:TrialLedger,
  analysis=managedAzureAnalysis) {
  const p=ledger.policy, id=trialHash(request.runId);
  if(request.policyDigest!==trialPolicyDigest(p)||!p.samples.some(s=>s.caseId===request.caseId))throw new TrialError();
  const saved=await ledger.inspect(id);
  if(!saved||saved.intent!==trialHash(JSON.stringify(request)))throw new TrialError();
  let run:ManagedRun|undefined;
  let current:ManagedWatchDispatchJournal|undefined;
  const budget={...p.cost!.normal,maximumYen:Math.max(1,3*trialCallYen(p,"normal",150_000,8192))};
  try {
    await ledger.claimWorker(id,execution);
    run=await repository.claimTrial(request.caseId,request.runId,execution,request.snapshotDigest,saved.expiresAt);
    const claimed=run;
    await withTrialAiBudget({kind:"compare",deadlineAt:Date.parse(saved.createdAt)+15*60_000,journal:{
      reserve:async e=>{await ledger.reserveCall(id,e);if(!current)throw new TrialError();await current.reserve(e);},
      reconcile:async e=>{if(!current)throw new TrialError();await current.reconcile(e);await ledger.reconcileCall(id,e);},
    }},async()=>{
      if(claimed.snapshot.candidates.length){
        const input=managedScreeningInput(claimed.snapshot);
        current=repository.journal(claimed,"screening",null,managedDigest(input),budget);
        const selected=validateManagedScreening(claimed,await analysis.screening(input));
        claimed.plan=await repository.saveScreening(claimed,selected);
        if(claimed.plan.chunks.length>2)throw new TrialError("trial_comparison_incomplete");
        for(let i=0;i<claimed.plan.chunks.length;i++){
          const chunk=claimed.plan.chunks[i];current=repository.journal(claimed,"detail",i,managedDigest(chunk),budget);
          await repository.saveDetail(claimed,i,await analysis.detail(chunk));
        }
      }
      await repository.finalize(claimed);
    });
    await ledger.complete(id,{persisted:true,execution});
  }catch{
    // A duplicate execution must never demote the already-claimed worker.
    if((await ledger.inspect(id))?.execution===execution){
      if(run)await repository.fail(run,await repository.hasUnknownDispatch(run));
      await ledger.markUnknown(id).catch(()=>undefined);
    }
    throw new TrialError("trial_comparison_incomplete");
  }
}
