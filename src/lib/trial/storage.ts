import { ContainerClient, type IHttpClient, type WebResource } from "@azure/storage-blob";
import { Readable } from "node:stream";
import { trialIdentity } from "./identity";
import { readTrialPolicy, requireTrialActive, trialPolicyDigest, TrialError, type TrialPolicy } from "./policy";
import type { OperatorAccess } from "./operator-access";
import { OWNER_STORAGE_BODY_LIMIT, type OwnerStorageBudget } from "./storage-budget";
import { configuredTrialNetworkBudget, type TrialNetworkAllowance } from "./network-budget";

export type TrialStoragePurpose = "originals" | "artifacts" | "budget";
/** The SDK invokes this adapter after its asynchronous bearer credential policy.
 * Thus even a cached token or refresh cannot bypass the final write boundary. */
export function trialStorageHttp(purpose:TrialStoragePurpose,p:TrialPolicy,transport:typeof fetch=globalThis.fetch,access?:OperatorAccess,ownerBudget?:OwnerStorageBudget,networkBudget?:TrialNetworkAllowance):IHttpClient {
  const origin=`https://${p.storage.account}.blob.core.windows.net`,prefix=`/${p.storage[purpose]}`;
  return {async sendRequest(request:WebResource){
    const u=new URL(request.url),controller=new AbortController();
    const abort=()=>controller.abort();request.abortSignal?.addEventListener("abort",abort);access?.signal.addEventListener("abort",abort);
    const timer=setTimeout(abort,20_000);
    let stage="target"; try{
      if(request.abortSignal?.aborted||access?.signal.aborted)abort();
      if(u.origin!==origin||u.username||u.password||u.hash||!([prefix,prefix+"/"].includes(u.pathname)||u.pathname.startsWith(prefix+"/"))||
        /%2f|%5c|\.\./i.test(u.pathname)||!["GET","HEAD","PUT"].includes(request.method)||
        (request.method==="PUT"&&(u.pathname===prefix||[...u.searchParams.keys()].some(k=>k!=="timeout")||
          u.searchParams.getAll("timeout").length>1||(u.searchParams.has("timeout")&&!/^(?:[1-9]|1[0-9]|20)$/.test(u.searchParams.get("timeout")!))))||
        !request.headers.get("authorization")?.startsWith("Bearer "))throw new TrialError();
      stage="body"; let body:Buffer|undefined;
      const bodyLimit=access||purpose==="budget"?OWNER_STORAGE_BODY_LIMIT:50*1024**2;
      if(request.method==="PUT"){
        const raw=typeof request.body==="function"?request.body():request.body;
        if(typeof raw==="string"||Buffer.isBuffer(raw)||raw instanceof Uint8Array)body=Buffer.from(raw);
        else if(raw&&Symbol.asyncIterator in Object(raw)){
          const chunks:Buffer[]=[];let n=0;
          for await(const chunk of raw as AsyncIterable<Uint8Array>){n+=chunk.length;if(n>bodyLimit)throw new TrialError();chunks.push(Buffer.from(chunk));}
          body=Buffer.concat(chunks);
        }else throw new TrialError();
        if(body.length>bodyLimit)throw new TrialError();
      }
      stage="headers"; const headers=new Headers();for(const k of request.headers.headerNames())headers.set(k,request.headers.get(k)!);
      const range=/^bytes=(\d+)-(\d+)$/.exec(request.headers.get("x-ms-range")??request.headers.get("range")??"");
      const rangeBytes=range?Number(range[2])-Number(range[1])+1:bodyLimit;
      if(!Number.isSafeInteger(rangeBytes)||rangeBytes<1)throw new TrialError();
      const responseLimit=request.method==="HEAD"?0:request.method==="PUT"?65536:Math.min(bodyLimit,rangeBytes);
      stage="guard";
      if(trialPolicyDigest(readTrialPolicy())!==trialPolicyDigest(p))throw new TrialError();
      if(purpose!=="budget"&&request.method==="PUT")requireTrialActive(p);
      access?.storage(purpose,request.url,request.method);
      if(access){
        if(!ownerBudget)throw new TrialError("trial_owner_storage_budget_required");
        ownerBudget.reserve(access,body?.length??0);
        // fsync can take time; expiry is checked again after durable reservation.
        access.storage(purpose,request.url,request.method);
      }
      // All roles consume the SAME durable lifetime quota, including the ledger
      // container, SDK recovery GETs and failed requests. Local fsync is an
      // additional guard, never a second allocation of the OWNER quota.
      const reserved=await (networkBudget??configuredTrialNetworkBudget(p)).reserve({service:"blob",purpose,
        method:request.method as "GET"|"HEAD"|"PUT",requestBytes:body?.length??0,responseLimit});
      // SQL/COMMIT proof may cross a deadline. No awaits after the final guard.
      if(trialPolicyDigest(readTrialPolicy())!==trialPolicyDigest(p))throw new TrialError();
      if(purpose!=="budget"&&request.method==="PUT")requireTrialActive(p);
      access?.storage(purpose,request.url,request.method);
      controller.signal.throwIfAborted();
      stage="send"; const response=await transport(request.url,{method:request.method,headers,body:body?new Uint8Array(body):undefined,signal:controller.signal,redirect:"error"});
      stage="response"; const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{
        {
          const length=response.headers.get("content-length"),encoding=response.headers.get("content-encoding");
          if(length===null||!/^\d+$/.test(length)||(request.method!=="HEAD"&&Number(length)>responseLimit)||(encoding&&encoding!=="identity"))throw new TrialError();
        }
        // The stream check bounds accepted bodies; a final oversized chunk may
        // already have arrived. It is not a claim about billed wire bytes.
        if(reader)for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;
          if(size>Math.min(responseLimit,response.ok?responseLimit:65536))throw new TrialError();chunks.push(v.value);}
        if(request.method!=="HEAD"&&size!==Number(response.headers.get("content-length")))throw new TrialError();
      }
      finally{if(reader){await reader.cancel().catch(()=>undefined);reader.releaseLock();}}
      const bytes=Buffer.concat(chunks),resultHeaders=request.headers.clone();
      for(const k of resultHeaders.headerNames())resultHeaders.remove(k);
      response.headers.forEach((v,k)=>resultHeaders.set(k,v));
      await reserved.observed(size,response.status);
      return {request,status:response.status,headers:resultHeaders,
        ...(request.streamResponseStatusCodes?.has(response.status)?{readableStreamBody:Readable.from([bytes])}:{bodyAsText:bytes.toString("utf8")})};
    }catch{throw new TrialError(`trial_storage_unavailable_${stage}`);}
    finally{clearTimeout(timer);request.abortSignal?.removeEventListener("abort",abort);access?.signal.removeEventListener("abort",abort);}
  }};
}
/** Credentials and endpoints come only from the process's signed policy. */
export function trialContainer(purpose: TrialStoragePurpose, policy: TrialPolicy = readTrialPolicy()) {
  const role = process.env.TRIAL_RUNTIME_ROLE;
  if (role !== "web" && role !== "worker") throw new TrialError("trial_storage_unavailable");
  return new ContainerClient(`https://${policy.storage.account}.blob.core.windows.net/${policy.storage[purpose]}`,
    trialIdentity(policy, role, "https://storage.azure.com/"),
    { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 },httpClient:trialStorageHttp(purpose,policy) });
}
export async function assertTrialPrivate(container: ContainerClient) {
  try {
    const p = await container.getProperties({ abortSignal: AbortSignal.timeout(20_000) });
    if (p.blobPublicAccess) throw new TrialError();
  } catch { throw new TrialError("trial_storage_unavailable"); }
}
