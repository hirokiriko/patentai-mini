import { TrialError } from "./policy";
import type { OperatorAccess } from "./operator-access";

/** The 1h data grant is not the DB usage window. Every SQL send obtains a fresh
 * 10s guardian permit; losing the permit closes the connection, including an
 * open transaction. An unacknowledged COMMIT remains unknown in the receipt. */
export class DatabasePermit {
  private until=0;
  private timer?:ReturnType<typeof setTimeout>;
  private heartbeat?:ReturnType<typeof setTimeout>;
  private refreshing?:Promise<void>;
  private reads=0;
  private stopped=false;
  constructor(readonly access:OperatorAccess,private readonly read:()=>Promise<unknown>,private readonly close:()=>unknown){
    if(!access.ticket.databaseWindow)throw new TrialError("trial_database_window_required");
    this.timer=setTimeout(()=>this.stop(),Math.max(0,Date.parse(access.ticket.databaseWindow.useUntil)-this.now()));
    this.timer.unref?.();
  }
  private now(){return Date.parse(this.access.ticket.endsAt)-this.access.check(0);}
  private stop(){this.stopped=true;clearTimeout(this.timer);clearTimeout(this.heartbeat);void Promise.resolve().then(()=>this.close()).catch(()=>undefined);}
  async refresh(){
    if(this.refreshing)return this.refreshing;
    this.refreshing=this.readPermit();
    try{await this.refreshing;}finally{this.refreshing=undefined;}
  }
  private async readPermit(){
    try{
      const d=this.access.ticket.databaseWindow!;
      if(this.stopped||++this.reads>2000||this.now()+5000>=Date.parse(d.useUntil))throw new TrialError();
      const s=await this.read() as Record<string,unknown>,now=this.now();
      const g=s.cloud_guard as Record<string,unknown>|undefined;
      const from=Date.parse(String(s.use_lease_from)),until=Date.parse(String(s.use_lease_until));
      if(s.binding_digest!==d.bindingDigest||s.lifecycle_id!==d.lifecycleId||s.rule_id!==d.ruleId||s.cleanup_strategy!=="single_job"||
        s.status!=="active"||s.usage_allowed!==true||s.close_requested!==false||s.blocked||g?.nonce!==d.guardianNonce||
        Date.parse(String(g.job_started_at))!==Date.parse(d.jobStartedAt)||Date.parse(String(s.cleanup_at))!==Date.parse(d.useUntil)||
        this.stopped||!Number.isFinite(from)||!Number.isFinite(until)||from>now||until-from>10000||until> Date.parse(d.useUntil)||until-now<3000)throw new TrialError();
      this.until=until;clearTimeout(this.timer);
      this.timer=setTimeout(()=>this.stop(),Math.max(0,until-this.now()));this.timer.unref?.();
      clearTimeout(this.heartbeat);
      this.heartbeat=setTimeout(()=>{void this.refresh().catch(()=>undefined);},Math.min(2000,Math.max(100,until-this.now()-5000)));
      this.heartbeat.unref?.();
    }catch{this.stop();throw new TrialError("trial_database_permit_unavailable");}
  }
  // The configured server-side statement timeout is 1s; retain another second
  // for dispatch. Transport loss still cannot establish a COMMIT outcome.
  assertSend(){if(this.stopped||this.now()+2000>=this.until){this.stop();throw new TrialError("trial_database_permit_expired");}}
  dispose(){clearTimeout(this.timer);clearTimeout(this.heartbeat);this.stopped=true;}
}

export function guardDatabasePermit<T extends {query:(...args:never[])=>unknown}>(client:T,permit:DatabasePermit){
  const original=client.query;
  let busy=false,unconfirmed=false;
  Object.defineProperty(client,"query",{value:async function(...args:unknown[]){
    // Acquire before the first await, including for ROLLBACK. Never enqueue a
    // query in pg with a permit checked while another statement was running.
    if(busy)throw new TrialError("trial_database_query_in_progress");
    if(unconfirmed)throw new TrialError("trial_database_connection_unconfirmed");
    const config=args[0] as {text?:unknown;callback?:unknown;submit?:unknown}|null|undefined;
    const text=typeof args[0]==="string"?args[0]:config?.text;
    // Only promise queries have a completion boundary this guard can hold.
    // Callback, cursor and custom Query objects must not release busy early.
    if(typeof text!=="string"||!text.trim()||args.some(value=>typeof value==="function")||
      (typeof args[0]==="object"&&(config?.callback!==undefined||config?.submit!==undefined)))
      throw new TrialError("trial_database_query_contract_invalid");
    busy=true;
    try{
      if(text.trim().toUpperCase()!=="ROLLBACK"){await permit.refresh();permit.assertSend();}
      try{
        const pending=Reflect.apply(original,client,args) as PromiseLike<unknown>|undefined;
        if(!pending||typeof pending.then!=="function")throw new TrialError("trial_database_query_contract_invalid");
        return await pending;
      }catch(error){
        // A transport/query timeout can settle the promise before the backend
        // has finished. Never place a retry or cleanup SQL behind that query.
        // The owning connection's finally closes it; its receipt stays unknown.
        unconfirmed=true;throw error;
      }
    }finally{busy=false;}
  }});
}

export function databasePermitReader(access:OperatorAccess,credential:{getToken:()=>Promise<{token:string}>},transport:typeof fetch=globalThis.fetch){
  const d=access.ticket.databaseWindow;if(!d)throw new TrialError("trial_database_window_required");
  return async()=>{
    access.check(10000);const token=await credential.getToken();access.check(10000);
    const now=Date.parse(access.ticket.endsAt)-access.check(0),remaining=Date.parse(d.useUntil)-now;
    if(remaining<=5000)throw new TrialError("trial_database_permit_expired");
    const signal=AbortSignal.any([access.signal,AbortSignal.timeout(Math.min(5000,remaining))]);
    const response=await transport(d.journalUrl,{method:"GET",headers:{Authorization:`Bearer ${token.token}`,"x-ms-version":"2023-11-03"},redirect:"error",signal});
    if(response.status!==200||!response.headers.get("etag"))throw new TrialError("trial_database_permit_unavailable");
    const reader=response.body?.getReader();if(!reader)throw new TrialError();
    const chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const v=await reader.read();if(v.done)break;size+=v.value.length;if(size>65536)throw new TrialError();chunks.push(v.value);}}
    finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}
