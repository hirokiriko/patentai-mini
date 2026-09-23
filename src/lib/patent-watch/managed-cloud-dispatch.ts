import { managedWatchJobTemplate, parseManagedCloudConfiguration, type ManagedCloudConfiguration } from "./managed-cloud-config";
import type { ManagedCloudStartRepository } from "../../repositories/managed-cloud-start";
import { ManagedWatchError } from "./managed-types";
import { managedDigest } from "./managed-claims";
const VERSION="2025-07-01";
const url=(config:ManagedCloudConfiguration)=>`https://management.azure.com${config.jobResourceId}`;
type Arm = (url:string,method:"GET"|"POST",body?:unknown)=>Promise<{status:number;body:unknown}>;
function templateMatches(actual:unknown,config:ManagedCloudConfiguration){
  if(!actual||typeof actual!=="object")return false;
  const t=actual as {containers?:Array<{name?:unknown;image?:unknown;command?:unknown;args?:unknown;resources?:unknown;env?:unknown;volumeMounts?:unknown}>;initContainers?:unknown};
  if(!Array.isArray(t.containers)||t.containers.length!==1||(t.initContainers!==undefined&&t.initContainers!==null&&JSON.stringify(t.initContainers)!=="[]"))return false;
  const c=t.containers[0],expected=managedWatchJobTemplate(config,false).containers[0];
  if(c.volumeMounts!==undefined&&c.volumeMounts!==null&&JSON.stringify(c.volumeMounts)!=="[]")return false;
  const normalizeEnv=(value:unknown)=>{
    if(!Array.isArray(value))return null;
    return value.map(e=>{
      if(!e||typeof e!=="object"||Object.keys(e).some(k=>!["name","value","secretRef"].includes(k)))return null;
      const {name,value,secretRef}=e;
      return {name,...(value!==null&&value!==undefined?{value}:{}),...(secretRef!==null&&secretRef!==undefined?{secretRef}:{})};
    })
      .sort((a,b)=>String(a?.name).localeCompare(String(b?.name)));
  };
  const resources=c.resources as {cpu?:unknown;memory?:unknown}|undefined;
  return c.name===expected.name&&c.image===expected.image&&managedDigest(c.command??[])===managedDigest(expected.command)&&
    managedDigest(c.args??[])===managedDigest(expected.args)&&resources?.cpu===2&&resources.memory==="4Gi"&&
    managedDigest(normalizeEnv(c.env))===managedDigest(normalizeEnv(expected.env));
}
/** A POST is possible only after a unique durable reservation and the submitting ACK.
 * The operator must include import/other costs in the monotone external ledger proof. */
export async function dispatchManagedWatch(starts:ManagedCloudStartRepository,value:unknown,arm:Arm){
  const config=parseManagedCloudConfiguration(value), target=await arm(`${url(config)}?api-version=${VERSION}`,"GET");
  const body=target.body as {id?:string;properties?:{configuration?:{triggerType?:string;replicaTimeout?:number;replicaRetryLimit?:number;manualTriggerConfig?:{parallelism?:number;replicaCompletionCount?:number}};template?:{containers?:Array<{image?:string}>}}};
  const c=body?.properties?.configuration, containers=body?.properties?.template?.containers;
  if(target.status!==200||body?.id?.toLowerCase()!==config.jobResourceId.toLowerCase()||c?.triggerType!=="Manual"||c.replicaRetryLimit!==0||
    !c.replicaTimeout||c.replicaTimeout>7200||c.replicaTimeout<5700||c.manualTriggerConfig?.parallelism!==1||c.manualTriggerConfig.replicaCompletionCount!==1||
    containers?.length!==1||containers[0].image!==config.image)throw new ManagedWatchError("unavailable");
  await starts.reserve(config);await starts.submitting(config);
  try{
    const result=await arm(`${url(config)}/start?api-version=${VERSION}`,"POST",managedWatchJobTemplate(config));
    if(![200,202].includes(result.status))throw Error();
    const execution=result.body as {name?:unknown;id?:unknown}|null;
    if(execution?.name!==undefined){
      if(typeof execution.name!=="string"||execution.id!==`${config.jobResourceId}/executions/${execution.name}`)throw Error();
      await starts.recordExecution(config,execution.name);
    }
    // Management-plane acceptance alone is not a claimed, accepted business run.
    const observed=await starts.get(config.operationId);
    return {operationId:config.operationId,status:observed.status==="accepted"||observed.status==="completed"?observed.status:"submitting"};
  }catch{
    const observed=await starts.get(config.operationId);
    if(observed.status==="accepted"||observed.status==="completed")return{operationId:config.operationId,status:observed.status};
    await starts.markUnknown(config);throw new ManagedWatchError("outcome_unknown");
  }
}
/** Reconcile a lost start ACK by matching the reserved fixed template, never resending POST. */
export async function reconcileManagedWatchStart(starts:ManagedCloudStartRepository,operationId:string,arm:Arm){
  const observed=await starts.get(operationId);
  if(!observed.executionId){
    const matches:string[]=[];
    let next=`${url(observed.config)}/executions?api-version=${VERSION}`,seen=0;
    for(let page=0;page<3&&next;page++){
      const response=await arm(next,"GET");
      const body=response.body as {value?:Array<{name?:unknown;id?:unknown;properties?:{template?:unknown}}> ;nextLink?:unknown};
      if(response.status!==200||!Array.isArray(body?.value)||body.value.length+(seen)>50)throw new ManagedWatchError("unavailable");
      seen+=body.value.length;
      for(const execution of body.value){
        // ARM may add null optional fields. Compare the business container contract only.
        if(templateMatches(execution.properties?.template,observed.config)&&typeof execution.name==="string"&&
          execution.id===`${observed.config.jobResourceId}/executions/${execution.name}`)matches.push(execution.name);
      }
      if(body.nextLink){
        if(typeof body.nextLink!=="string"||body.nextLink.length>4096)throw new ManagedWatchError("incomplete");
        const link=new URL(body.nextLink);
        if(link.origin!=="https://management.azure.com"||link.pathname!==`${observed.config.jobResourceId}/executions`||
          [...link.searchParams.keys()].some(k=>!["api-version","$skipToken"].includes(k))||link.searchParams.get("api-version")!==VERSION)throw new ManagedWatchError("incomplete");
        next=link.href;
      }else next="";
    }
    if(next)throw new ManagedWatchError("limit");
    if(matches.length===1){await starts.recordExecution(observed.config,matches[0]);observed.executionId=matches[0];}
  }
  if(observed.executionId){
    if(!/^[a-z0-9-]{1,100}$/.test(observed.executionId)||!observed.executionId.startsWith(observed.config.jobName+"-"))throw new ManagedWatchError("incomplete");
    const response=await arm(`${url(observed.config)}/executions/${observed.executionId}?api-version=${VERSION}`,"GET");
    if(response.status!==200)throw new ManagedWatchError("unavailable");
    const status=(response.body as {properties?:{status?:unknown}})?.properties?.status;
    return {operationId,status:observed.status,executionStatus:["Running","Succeeded","Failed","Stopped","Processing","Unknown"].includes(String(status))?String(status):"Unknown",
      runs:observed.runs.map(r=>({runId:r.runId,caseId:r.caseId,status:r.status,consumedNormal:r.consumedNormal}))};
  }
  return {operationId,status:observed.status,executionStatus:"Unknown",runs:[]};
}
