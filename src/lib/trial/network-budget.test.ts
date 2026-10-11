import { afterEach,describe,expect,it,vi } from "vitest";
import { networkBudgetFixture } from "./network-budget.test-support";
import { TRIAL_ARM_REQUEST_LIMIT,TRIAL_STORAGE_REQUEST_LIMIT,TRIAL_STORAGE_RESERVED_BYTES,TRIAL_NETWORK_CONSTRAINTS,verifyTrialNetworkTable } from "./network-budget";
import { trialFixture,signedTrialEnvironment } from "./policy.test-support";
import { TRIAL_START } from "./policy";
const request={service:"blob" as const,purpose:"budget" as const,method:"GET" as const,requestBytes:0,responseLimit:4096};
function fixture(){vi.useFakeTimers();vi.setSystemTime(new Date(TRIAL_START));
  for(const[k,v]of Object.entries(signedTrialEnvironment()))vi.stubEnv(k,v);return networkBudgetFixture(trialFixture);}
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();});
describe("shared durable trial network allowance",()=>{
  it("shares the last request across roles, concurrency and process restarts",async()=>{
    const f=fixture();f.state.blob.requests=TRIAL_STORAGE_REQUEST_LIMIT-1;
    const results=await Promise.allSettled([f.budget.reserve(request),f.restart().reserve(request)]);
    expect(results.filter(v=>v.status==="fulfilled")).toHaveLength(1);
    await expect(f.restart().reserve(request)).rejects.toThrow();expect(f.state.blob.requests).toBe(TRIAL_STORAGE_REQUEST_LIMIT);
  });
  it("retains unknown SQL commits and permits no returned send handle",async()=>{
    const f=fixture();f.lose();await expect(f.budget.reserve(request)).rejects.toThrow("trial_network_budget_unavailable");
    expect(f.state.blob.requests).toBe(1);expect(f.state.receipts[0].observed).toBeNull();
    await f.restart().reserve(request);expect(f.state.blob.requests).toBe(2);
  });
  it.each(["in progress","aborted",null])("refuses a send before independently confirmed COMMIT: %s",async proof=>{
    const f=fixture();f.proof(proof as string);await expect(f.budget.reserve(request)).rejects.toThrow();
    expect(f.state.blob.requests).toBe(1);
  });
  it("retains both request and full response ceilings after successful observation",async()=>{
    const f=fixture(),r=await f.budget.reserve(request);await r.observed(10,200);
    expect(f.state.blob).toEqual({requests:1,bytes:4096});expect(f.state.receipts[0].observed).toBe(10);
    await expect(r.observed(10,200)).rejects.toThrow();
  });
  it("never retries or refunds a lost observation acknowledgement",async()=>{
    const f=fixture(),r=await f.budget.reserve(request);f.loseSettlement();
    await expect(r.observed(10,200)).rejects.toThrow("trial_network_observation_unknown");
    await expect(r.observed(10,200)).rejects.toThrow();expect(f.state.blob.bytes).toBe(4096);
  });
  it("shares the existing byte and ARM caps without another role allowance",async()=>{
    const f=fixture();f.state.blob.bytes=TRIAL_STORAGE_RESERVED_BYTES-4095;
    await expect(f.budget.reserve(request)).rejects.toThrow();expect(f.state.blob.requests).toBe(0);
    f.state.arm.requests=TRIAL_ARM_REQUEST_LIMIT-1;
    await f.budget.reserve({...request,service:"arm",purpose:"job",method:"POST"});
    await expect(f.restart().reserve({...request,service:"arm",purpose:"job"})).rejects.toThrow();
  });
  it("rejects invalid body quantities and changed policy before SQL",async()=>{
    const f=fixture();for(const n of [-1,NaN,Infinity,Number.MAX_SAFE_INTEGER])await expect(f.budget.reserve({...request,requestBytes:n})).rejects.toThrow();
    vi.stubEnv("TRIAL_POLICY_SIGNATURE","invalid");await expect(f.budget.reserve(request)).rejects.toThrow();expect(f.state.blob.requests).toBe(0);
  });
});

describe("fixed network table reconciliation",()=>{
  function metadata(){
    const types=["binding:text","service:text","slot:integer","purpose:text","method:text","request_bytes:integer","response_limit:integer","requests:integer","reserved_bytes:bigint","observed_bytes:integer","http_status:integer"];
    return {table:{owner:"fixture_owner",relkind:"r",relrowsecurity:false,relpersistence:"p",relispartition:false,relhasrules:false},
      columns:types.map((t,i)=>({attname:t.split(":")[0],type:t.split(":")[1],attnotnull:i<9,attidentity:"",attgenerated:"",default_value:i===7||i===8?"0":null})),
      constraints:TRIAL_NETWORK_CONSTRAINTS.map(definition=>({definition,convalidated:true,condeferrable:false,condeferred:false})),bad:false};
  }
  function database(m:ReturnType<typeof metadata>){return{query:async(text:string)=>({rows:text.includes("from pg_class")?[m.table]:text.includes("from pg_attribute")?m.columns:text.includes("from pg_constraint")?m.constraints:[{bad:m.bad}]})};}
  it("accepts only the complete fixed PG16 metadata",async()=>{const m=metadata();expect(await verifyTrialNetworkTable(database(m),"fixture_owner")).toBe(true);});
  it.each(["constraint","default","trigger","deferred","owner","generated"])("rejects altered %s without DDL",async kind=>{
    const m=metadata();
    if(kind==="constraint")m.constraints.pop();if(kind==="default")m.columns[7].default_value="3403";if(kind==="trigger")m.bad=true;
    if(kind==="deferred")m.constraints[0].condeferrable=true;if(kind==="owner")m.table.owner="other";if(kind==="generated")m.columns[0].attgenerated="s";
    expect(await verifyTrialNetworkTable(database(m),"fixture_owner")).toBe(false);
  });
});
