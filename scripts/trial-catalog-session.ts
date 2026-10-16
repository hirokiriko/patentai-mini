import { z } from "zod";
import {installTrialSessionOwnerTokenReader} from "./trial-owner-token";
import { CatalogAccess } from "../src/lib/trial/catalog-access";
import { CatalogAudit } from "../src/lib/trial/catalog-runtime";
import { loadCatalogBuiltins } from "../src/lib/trial/catalog-builtins";
import { catalogPlanSchema } from "../src/lib/trial/catalog-schema";
import { catalogDigest } from "../src/lib/trial/catalog-queries";
import { installCountedSessionPermitReader } from "../src/lib/trial/database-permit";
import { operatorTicketSchema } from "../src/lib/trial/operator-access";
import { TrialError } from "../src/lib/trial/policy";
import { verifyTrialBuild } from "../src/lib/trial/runtime";
import { trialAzureCliPythonSchema } from "./trial-owner-token";
import { runTrialBootstrap } from "./trial-bootstrap";
import { runTrialOperator } from "./trial-operator";
import { databaseWindowSchema, environmentSchema, executeTrialSession, prepareTrialSession, saveTrialBootstrapProof,
  saveTrialRuntimePolicy, SessionPermit, trialSessionInput, type SessionClock } from "./trial-session";

const digestSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const catalogStartSchema=z.object({type:z.literal("catalog_start"),schema:z.literal(1),environment:environmentSchema,
  access:operatorTicketSchema,azureCliPython:trialAzureCliPythonSchema,recoveryDirectory:z.string().min(1),databaseWindow:databaseWindowSchema,
  catalogPlan:catalogPlanSchema,admin:z.object({adminUrl:z.string().min(1).max(8192),adminUser:z.string()}).strict(),bootstrapBinding:digestSchema}).strict();
const bootstrapFrame=z.object({type:z.literal("bootstrap"),schema:z.literal(1),catalogPass1Sha256:digestSchema,payload:trialSessionInput}).strict();
const snapshotFrame=z.object({type:z.literal("permit_snapshot"),schema:z.literal(1),id:z.number().int().positive().max(3000),snapshot:z.record(z.string(),z.unknown())}).strict();
const tokenFrame=z.object({type:z.literal("owner_token"),schema:z.literal(1),id:z.number().int().positive().max(16),
  credential:z.object({accessToken:z.string().min(1).max(32768),tenant:z.string(),expires_on:z.number().finite()}).strict()}).strict();
const failure=()=>new TrialError("trial_catalog_session_unconfirmed");
export function catalogBootstrapBinding(input:z.infer<typeof trialSessionInput>){
  const url=new URL(input.operatorDatabaseUrl);
  return catalogDigest({environment:input.environment,access:input.access,azureCliPython:input.azureCliPython,
    recoveryDirectory:input.recoveryDirectory,databaseWindow:input.databaseWindow,manifest:input.bootstrap.manifest,mode:input.bootstrap.mode,
    requests:input.requests,operatorTarget:{host:url.hostname,database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username)}});
}
export function validateCatalogCommands(input:z.infer<typeof trialSessionInput>){
  const cases=input.bootstrap.manifest.cases;
  if(input.bootstrap.mode!=="apply"||cases.length!==4||input.requests.length!==10)throw failure();
  const req=z.array(z.record(z.string(),z.unknown())).parse(input.requests);
  if(req[0].command!=="initialize-ledger"||req[1].command!=="package-import")throw failure();
  for(const [i,c]of cases.entries()){
    const at=2+i*2,setting=z.record(z.string(),z.unknown()).parse(req[at+1].setting);
    if(req[at].command!=="sample-save"||req[at].caseId!==c.id||req[at+1].command!=="setting-save"||setting.caseId!==c.id)throw failure();
    for(const field of ["base","source"])if(catalogDigest(setting[field])!==catalogDigest({$sessionResult:{requestIndex:at,field}}))throw failure();
  }
}

/** Bootstrap secrets are absent until pass1 has reached the parent. All permit
 * reads go through the parent's single lifetime counter and fixed GET broker. */
export async function runCatalogSession(value:unknown,channel:{clock?:SessionClock;signal:AbortSignal;onStop():void;
  register(fn:(value:unknown)=>void):void;send(value:unknown):void}){
  const start=catalogStartSchema.parse(value);
  const permit=new SessionPermit(start.databaseWindow,channel.onStop,channel.clock);
  const access=new CatalogAccess(start.environment,start.access,start.databaseWindow,permit.signal,channel.clock);
  let pass1:string|undefined, bootstrapReceived=false, requestId=0, audit:CatalogAudit|undefined;
  let pending:{id:number;resolve:(v:unknown)=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  let tokenId=0,tokenPending:{id:number;resolve:(v:z.infer<typeof tokenFrame>["credential"])=>void;reject:(e:unknown)=>void;timer:ReturnType<typeof setTimeout>}|undefined;
  let resolveBootstrap:(v:z.infer<typeof trialSessionInput>)=>void=()=>undefined;
  let rejectBootstrap:(e:unknown)=>void=()=>undefined;
  const bootstrap=new Promise<z.infer<typeof trialSessionInput>>((resolve,reject)=>{resolveBootstrap=resolve;rejectBootstrap=reject;});
  // Attach rejection immediately; an early invalid frame must not become an
  // unhandled rejection before the first pass reaches the bootstrap await.
  void bootstrap.catch(()=>undefined);
  const stop=()=>{if(pending){clearTimeout(pending.timer);pending.reject(failure());pending=undefined;}
    if(tokenPending){clearTimeout(tokenPending.timer);tokenPending.reject(failure());tokenPending=undefined;}rejectBootstrap(failure());permit.stop();};
  channel.signal.addEventListener("abort",stop,{once:true});
  let inflight:Promise<unknown>|undefined;
  const revoke=installCountedSessionPermitReader(start.databaseWindow,()=>{
    if(inflight)return inflight;
    permit.check();if(requestId>=3000)throw failure();const id=++requestId;
    const work=new Promise<unknown>((resolve,reject)=>{
      pending={id,resolve,reject,timer:setTimeout(()=>{stop();},5500)};
      try{channel.send({type:"permit_request",schema:1,id});}catch{stop();}
    });
    inflight=work.finally(()=>{inflight=undefined;});return inflight;
  });
  const revokeToken=installTrialSessionOwnerTokenReader(access.policy,audience=>{
    permit.check();if(!bootstrapReceived||tokenPending||tokenId>=16)throw failure();const id=++tokenId;
    return new Promise((resolve,reject)=>{
      tokenPending={id,resolve,reject,timer:setTimeout(stop,5500)};
      try{channel.send({type:"owner_token_request",schema:1,id,audience});}catch{stop();}
    });
  });
  try{
    channel.register(frame=>{
      try{
        if(!frame||typeof frame!=="object")throw failure();
        const type=(frame as {type?:unknown}).type;
        if(type==="permit"){permit.grant(frame);return;}
        if(type==="owner_token"){
          const v=tokenFrame.parse(frame);if(!tokenPending||v.id!==tokenPending.id)throw failure();
          const done=tokenPending;tokenPending=undefined;clearTimeout(done.timer);done.resolve(v.credential);return;
        }
        if(type==="permit_snapshot"){
          const v=snapshotFrame.parse(frame);if(!pending||v.id!==pending.id)throw failure();
          const done=pending;pending=undefined;clearTimeout(done.timer);done.resolve(v.snapshot);return;
        }
        const v=bootstrapFrame.parse(frame);
        if(!pass1||bootstrapReceived||v.catalogPass1Sha256!==pass1||catalogBootstrapBinding(v.payload)!==start.bootstrapBinding||
          catalogDigest(v.payload.databaseWindow)!==catalogDigest(start.databaseWindow)||v.payload.bootstrap.credentials.adminUrl!==start.admin.adminUrl||
          v.payload.bootstrap.manifest.adminUser!==start.admin.adminUser)throw failure();
        validateCatalogCommands(v.payload);bootstrapReceived=true;resolveBootstrap(v.payload);
      }catch{stop();throw failure();}
    });
    await permit.wait();await verifyTrialBuild(access.policy);permit.check();
    // Catalog connections cannot acquire a storage token themselves.
    audit=new CatalogAudit(start.catalogPlan,loadCatalogBuiltins(),access,start.admin.adminUrl,start.recoveryDirectory,
      {getToken:async()=>{throw failure();}});
    const first=await audit.runPass(1);pass1=first.sha256;channel.send(first);
    const payload=await bootstrap;permit.check();const prepared=prepareTrialSession(payload,channel.clock);
    const result=await executeTrialSession(prepared,permit,{
      runtimePolicy:saveTrialRuntimePolicy,bootstrapProof:saveTrialBootstrapProof,operator:runTrialOperator,
      async bootstrap(input){return runTrialBootstrap(input,async()=>{channel.send(await audit!.runPass(2));return audit!.issueBootstrapCapability();});},
      async beforeRelease(){channel.send(await audit!.runPass(3));},
    });
    return{...result,catalog:audit.result()};
  }catch{stop();throw failure();}
  finally{revoke();revokeToken();channel.signal.removeEventListener("abort",stop);permit.dispose();access.dispose();await audit?.close();}
}
