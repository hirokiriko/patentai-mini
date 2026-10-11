import { afterEach,describe,expect,it,vi } from "vitest";
import { OperatorAccess,operatorPolicyBinding,operatorTicketDigest,type OperatorTicket } from "./operator-access";
import { DatabasePermit,databasePermitReader,guardDatabasePermit } from "./database-permit";
import { trialFixture } from "./policy.test-support";
import { TRIAL_START } from "./policy";

const start=Date.parse(TRIAL_START),id="11111111-1111-4111-8111-111111111111";
function setup(){
  vi.useFakeTimers();vi.setSystemTime(start+1000);
  const p=structuredClone(trialFixture);
  const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:new Date(start).toISOString(),
    endsAt:new Date(start+3600000).toISOString(),packages:[],samples:[],artifacts:[],
    databaseWindow:{lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fictional",ruleId:`/subscriptions/${id}/resourceGroups/fictional/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional/firewallRules/guard`,
      journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:new Date(start).toISOString(),useUntil:new Date(start+600000).toISOString()}};
  p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"b".repeat(64)};
  const access=new OperatorAccess(ticket,p,{utc:()=>Date.now(),monotonic:()=>Date.now()-start});
  const state=()=>({binding_digest:ticket.databaseWindow!.bindingDigest,lifecycle_id:id,rule_id:ticket.databaseWindow!.ruleId,
    cleanup_strategy:"single_job",status:"active",usage_allowed:true,close_requested:false,blocked:null,
    cloud_guard:{nonce:"fictional",job_started_at:ticket.databaseWindow!.jobStartedAt},cleanup_at:ticket.databaseWindow!.useUntil,
    use_lease_from:new Date(Date.now()).toISOString(),use_lease_until:new Date(Math.min(Date.now()+10000,start+600000)).toISOString()});
  return{access,state};
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});
describe("one counted session permit broadcaster",()=>{
  async function sharedSetup(count=10){
    vi.resetModules();const{access,state}=setup(),api=await import("./database-permit");
    const read=vi.fn<()=>Promise<unknown>>(async()=>state()),revoke=api.installCountedSessionPermitReader(access.ticket.databaseWindow!,read);
    const credential={getToken:vi.fn(async()=>({token:"fictional"}))},network=vi.fn<typeof fetch>(),close=Array.from({length:count},()=>vi.fn());
    const permits=close.map(end=>new api.DatabasePermit(access,api.databasePermitReader(access,credential,network),end));
    const cleanup=()=>{for(const permit of permits)permit.dispose();revoke();access.dispose();vi.clearAllTimers();};
    return{api,access,state,read,revoke,credential,network,close,permits,cleanup};
  }
  it("coalesces pending reads from D+4 connections and schedules only one idle refresh",async()=>{
    const s=await sharedSetup();let finish:(value:unknown)=>void=()=>undefined;s.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    try{
      const pending=Promise.all(s.permits.map(p=>p.refresh()));expect(s.read).toHaveBeenCalledOnce();finish(s.state());await pending;
      await vi.advanceTimersByTimeAsync(2000);expect(s.read).toHaveBeenCalledTimes(2);
      for(const p of s.permits)expect(()=>p.assertSend()).not.toThrow();for(const close of s.close)expect(close).not.toHaveBeenCalled();
      expect(s.credential.getToken).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();
    }finally{s.cleanup();}
  });
  it("does not answer later SQL with a previously settled snapshot",async()=>{
    const s=await sharedSetup(2),calls=[vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({})),vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({}))];
    const clients=calls.map(query=>({query}));clients.forEach((c,i)=>s.api.guardDatabasePermit(c,s.permits[i]));
    try{
      await clients[0].query("select 1");expect(s.read).toHaveBeenCalledTimes(1);await clients[1].query("select 1");expect(s.read).toHaveBeenCalledTimes(2);
      await clients[0].query("COMMIT");expect(s.read).toHaveBeenCalledTimes(3);expect(calls[0]).toHaveBeenCalledTimes(2);expect(calls[1]).toHaveBeenCalledOnce();
    }finally{s.cleanup();}
  });
  it("closes every connection within its ten-second lease while refresh hangs without revival",async()=>{
    const s=await sharedSetup();let finish:(value:unknown)=>void=()=>undefined;
    try{
      await Promise.all(s.permits.map(p=>p.refresh()));s.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
      await vi.advanceTimersByTimeAsync(10001);expect(s.read).toHaveBeenCalledTimes(2);for(const close of s.close)expect(close).toHaveBeenCalled();
      finish(s.state());await vi.advanceTimersByTimeAsync(0);const count=s.read.mock.calls.length;
      for(const p of s.permits){await expect(p.refresh()).rejects.toThrow();expect(()=>p.assertSend()).toThrow();}
      await vi.advanceTimersByTimeAsync(20000);expect(s.read).toHaveBeenCalledTimes(count);expect(s.network).not.toHaveBeenCalled();
    }finally{s.cleanup();}
  });
  it("does not recreate idle timers when the last listener disposes during a response",async()=>{
    const s=await sharedSetup(1);let finish:(value:unknown)=>void=()=>undefined;s.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    try{
      const pending=expect(s.permits[0].refresh()).rejects.toThrow();s.permits[0].dispose();finish(s.state());await pending;
      await vi.advanceTimersByTimeAsync(10000);expect(s.read).toHaveBeenCalledOnce();await expect(s.permits[0].refresh()).rejects.toThrow();expect(s.read).toHaveBeenCalledOnce();
    }finally{s.cleanup();}
  });
  it("permanently revokes pending sources with no credential or fetch fallback",async()=>{
    const s=await sharedSetup(1);let finish:(value:unknown)=>void=()=>undefined;s.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    try{
      const pending=expect(s.permits[0].refresh()).rejects.toThrow();s.revoke();finish(s.state());await pending;
      await expect(s.api.databasePermitReader(s.access,s.credential,s.network)()).rejects.toThrow();await expect(s.permits[0].refresh()).rejects.toThrow();
      expect(()=>s.api.installCountedSessionPermitReader(s.access.ticket.databaseWindow!,s.read)).toThrow();await vi.advanceTimersByTimeAsync(10000);
      expect(s.read).toHaveBeenCalledOnce();expect(s.credential.getToken).not.toHaveBeenCalled();expect(s.network).not.toHaveBeenCalled();
    }finally{s.cleanup();}
  });
  it("bounds idle reads for the full 600-second window independently of connection count",async()=>{
    const s=await sharedSetup();
    try{
      await Promise.all(s.permits.map(p=>p.refresh()));await vi.advanceTimersByTimeAsync(600000);expect(s.read.mock.calls.length).toBeLessThanOrEqual(301);
      for(const close of s.close)expect(close).toHaveBeenCalled();const count=s.read.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);
      for(const p of s.permits)await expect(p.refresh()).rejects.toThrow();expect(s.read).toHaveBeenCalledTimes(count);
    }finally{s.cleanup();}
  });
});
describe("guardian database permit",()=>{
  it("renews across a healthy 20 second Blob wait then checks the next SQL",async()=>{
    const{access,state}=setup(),read=vi.fn(async()=>state()),close=vi.fn(),query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({}));
    const permit=new DatabasePermit(access,read,close),client={query};guardDatabasePermit(client,permit);
    await client.query("BEGIN" as never);await vi.advanceTimersByTimeAsync(20000);await client.query("COMMIT" as never);
    expect(read.mock.calls.length).toBeGreaterThan(10);expect(close).not.toHaveBeenCalled();expect(query).toHaveBeenCalledTimes(2);
    permit.dispose();access.dispose();
  });
  it("rejects COMMIT when the guardian withdraws use and permits rollback cleanup",async()=>{
    const{access,state}=setup();let allowed=true;const close=vi.fn(),query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({}));
    const permit=new DatabasePermit(access,async()=>({...state(),usage_allowed:allowed}),close),client={query};guardDatabasePermit(client,permit);
    await client.query("BEGIN" as never);allowed=false;
    await expect(client.query("COMMIT" as never)).rejects.toThrow();await client.query("ROLLBACK" as never);
    expect(query.mock.calls.map(c=>c[0])).toEqual(["BEGIN","ROLLBACK"]);expect(close).toHaveBeenCalled();permit.dispose();access.dispose();
  });
  it("expires the live connection when refresh hangs and never revives it from a late response",async()=>{
    const{access,state}=setup(),close=vi.fn();let done:(v:unknown)=>void=()=>undefined,calls=0;
    const permit=new DatabasePermit(access,()=>++calls===1?Promise.resolve(state()):new Promise(r=>{done=r;}),close);
    await permit.refresh();await vi.advanceTimersByTimeAsync(10001);expect(close).toHaveBeenCalled();
    done(state());await Promise.resolve();await expect(permit.refresh()).rejects.toThrow();expect(()=>permit.assertSend()).toThrow();permit.dispose();access.dispose();
  });
  it("stops before the fixed ten-minute cutoff while the one-hour ticket remains valid",async()=>{
    const{access,state}=setup(),close=vi.fn(),permit=new DatabasePermit(access,async()=>state(),close);
    vi.setSystemTime(start+596000);await expect(permit.refresh()).rejects.toThrow();expect(access.check(0)).toBeGreaterThan(0);
    permit.dispose();access.dispose();
  });
  it("rejects oversized leases, wrong bindings and final sends with too little server timeout margin",async()=>{
    const{access,state}=setup();const s=state(),permit=new DatabasePermit(access,async()=>({...s,use_lease_until:new Date(Date.now()+11000).toISOString()}),vi.fn());
    await expect(permit.refresh()).rejects.toThrow();permit.dispose();access.dispose();
  });
  it("does not send a journal GET when token acquisition passes the DB cutoff",async()=>{
    const{access}=setup(),network=vi.fn();const read=databasePermitReader(access,{getToken:async()=>{vi.setSystemTime(start+600000);return{token:"fictional"};}},network);
    await expect(read()).rejects.toThrow();expect(network).not.toHaveBeenCalled();access.dispose();
  });
  it("requires ETag and bounded JSON from the exact fixed journal",async()=>{
    const{access,state}=setup(),network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(state()),{headers:{etag:'"fixed"'}}));
    const value=await databasePermitReader(access,{getToken:async()=>({token:"fictional"})},network)();expect(value.status).toBe("active");
    expect(network.mock.calls[0][0]).toBe(access.ticket.databaseWindow!.journalUrl);access.dispose();
  });
  it("rejects a second SQL or rollback while the first permit read is pending",async()=>{
    const{access,state}=setup(),query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({}));
    let release:(value:unknown)=>void=()=>undefined;
    const read=vi.fn(()=>new Promise<unknown>(resolve=>{release=resolve;}));
    const permit=new DatabasePermit(access,read,vi.fn()),client={query};guardDatabasePermit(client,permit);
    const first=client.query("BEGIN");
    await expect(client.query("COMMIT")).rejects.toThrow("trial_database_query_in_progress");
    await expect(client.query("ROLLBACK")).rejects.toThrow("trial_database_query_in_progress");
    expect(read).toHaveBeenCalledOnce();expect(query).not.toHaveBeenCalled();
    release(state());await first;expect(query).toHaveBeenCalledOnce();permit.dispose();access.dispose();
  });
  it("holds the send boundary until SQL completion and obtains a fresh permit for the next SQL",async()=>{
    const{access,state}=setup(),read=vi.fn(async()=>state());
    let entered:()=>void=()=>undefined,release:(value:object)=>void=()=>undefined;
    const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<object>(resolve=>{release=resolve;});
    const query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>{entered();return pending;});
    const permit=new DatabasePermit(access,read,vi.fn()),client={query};guardDatabasePermit(client,permit);
    const first=client.query("insert into fictional values (1)");await started;
    await expect(client.query("COMMIT")).rejects.toThrow("trial_database_query_in_progress");
    await expect(client.query("ROLLBACK")).rejects.toThrow("trial_database_query_in_progress");
    expect(query).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();
    release({});await first;await client.query("COMMIT");
    expect(query.mock.calls.map(args=>args[0])).toEqual(["insert into fictional values (1)","COMMIT"]);
    expect(read).toHaveBeenCalledTimes(2);permit.dispose();access.dispose();
  });
  it("never reuses a connection after an unacknowledged SQL, including COMMIT or rollback",async()=>{
    const{access,state}=setup(),read=vi.fn(async()=>state());
    const query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>{throw new Error("fictional lost acknowledgement");});
    const permit=new DatabasePermit(access,read,vi.fn()),client={query};guardDatabasePermit(client,permit);
    await expect(client.query("COMMIT")).rejects.toThrow("lost acknowledgement");
    for(const sql of ["COMMIT","select 1","ROLLBACK"])await expect(client.query(sql)).rejects.toThrow("trial_database_connection_unconfirmed");
    expect(query).toHaveBeenCalledOnce();expect(read).toHaveBeenCalledOnce();permit.dispose();access.dispose();
  });
  it("rejects callback and cursor contracts before obtaining a permit or sending SQL",async()=>{
    const{access,state}=setup(),read=vi.fn(async()=>state()),query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({}));
    const permit=new DatabasePermit(access,read,vi.fn()),client={query};guardDatabasePermit(client,permit);
    const callback=vi.fn();
    await expect(client.query("select 1",callback)).rejects.toThrow("trial_database_query_contract_invalid");
    await expect(client.query({text:"select 1",callback})).rejects.toThrow("trial_database_query_contract_invalid");
    await expect(client.query({text:"select 1",submit:vi.fn()})).rejects.toThrow("trial_database_query_contract_invalid");
    expect(callback).not.toHaveBeenCalled();expect(read).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
    await client.query({text:"select $1",values:[1]});expect(query).toHaveBeenCalledOnce();permit.dispose();access.dispose();
  });
  it("permits only a non-concurrent exact rollback after lease withdrawal, never mixed SQL",async()=>{
    const{access,state}=setup(),read=vi.fn(async()=>({...state(),usage_allowed:false}));
    const query=vi.fn<(...args:unknown[])=>Promise<object>>(async()=>({})),permit=new DatabasePermit(access,read,vi.fn()),client={query};guardDatabasePermit(client,permit);
    await expect(client.query("COMMIT")).rejects.toThrow("trial_database_permit_unavailable");
    await expect(client.query("ROLLBACK; insert into fictional values (1)")).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();await client.query("  rollback  ");expect(query.mock.calls).toEqual([["  rollback  "]]);
    permit.dispose();access.dispose();
  });
});
