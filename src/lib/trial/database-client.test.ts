import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { OperatorAccess,operatorPolicyBinding,operatorTicketDigest,type OperatorTicket } from "./operator-access";
import { trialFixture } from "./policy.test-support";
import { TRIAL_START } from "./policy";

const pg=vi.hoisted(()=>({
  options:[] as Array<Record<string,unknown>>,
  clients:[] as Array<{connect:ReturnType<typeof vi.fn>;query:ReturnType<typeof vi.fn>;end:ReturnType<typeof vi.fn>}>,
  queries:[] as Array<ReturnType<typeof vi.fn>>,
  rows:[] as Array<Record<string,unknown>>,
  connectError:null as Error|null,
  queryError:null as Error|null,
}));
vi.mock("pg",()=>({Client:class {
  connect=vi.fn(async()=>{if(pg.connectError)throw pg.connectError;});
  query=vi.fn(async()=>{if(pg.queryError)throw pg.queryError;return{rows:pg.rows};});
  end=vi.fn(async()=>undefined);
  on=vi.fn();
  constructor(options:Record<string,unknown>){pg.options.push(options);pg.clients.push(this);pg.queries.push(this.query);}
}}));

const start=Date.parse(TRIAL_START),id="11111111-1111-4111-8111-111111111111";
let access:OperatorAccess;
let connectPermitDatabase:typeof import("./database-client").connectPermitDatabase;
let target:{url:string;host:string;database:string;user:string};
let network:ReturnType<typeof vi.fn<typeof fetch>>;
let credential:{getToken:ReturnType<typeof vi.fn<()=>Promise<{token:string}>>>};
beforeEach(async()=>{
  // Reset the module only in this test harness; production exposes no budget reset.
  vi.resetModules();vi.useFakeTimers();vi.setSystemTime(start+1000);
  for(const name of ["PGOPTIONS","PGREPLICATION","PGSERVICE"])vi.stubEnv(name,undefined);
  pg.options.length=0;pg.clients.length=0;pg.queries.length=0;pg.connectError=null;pg.queryError=null;
  const p=structuredClone(trialFixture);
  p.database.migratorUser="trial_migrator";p.database.ownerRole="trial_owner";
  const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:new Date(start).toISOString(),
    endsAt:new Date(start+3600000).toISOString(),packages:[],samples:[],artifacts:[],
    databaseWindow:{lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fictional",ruleId:`/subscriptions/${id}/resourceGroups/fictional/providers/Microsoft.DBforPostgreSQL/flexibleServers/fictional/firewallRules/guard`,
      journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:new Date(start).toISOString(),useUntil:new Date(start+600000).toISOString()}};
  p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"b".repeat(64)};
  access=new OperatorAccess(ticket,p,{utc:()=>Date.now(),monotonic:()=>Date.now()-start});
  target={host:p.database.host,database:p.database.database,user:p.database.migratorUser!,
    url:`postgresql://${p.database.migratorUser}:fictional-password@${p.database.host}:5432/${p.database.database}`};
  pg.rows=[{db:target.database,usr:target.user,tls:true,statement_timeout_ms:1000,lock_timeout_ms:500,idle_transaction_timeout_ms:9000}];
  network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({
    binding_digest:ticket.databaseWindow!.bindingDigest,lifecycle_id:id,rule_id:ticket.databaseWindow!.ruleId,
    cleanup_strategy:"single_job",status:"active",usage_allowed:true,close_requested:false,blocked:null,
    cloud_guard:{nonce:"fictional",job_started_at:ticket.databaseWindow!.jobStartedAt},cleanup_at:ticket.databaseWindow!.useUntil,
    use_lease_from:new Date(Date.now()).toISOString(),use_lease_until:new Date(Date.now()+10000).toISOString(),
  }),{headers:{etag:'"fixture"'}}));
  vi.stubGlobal("fetch",network);
  credential={getToken:vi.fn(async()=>({token:"fictional"}))};
  ({connectPermitDatabase}=await import("./database-client"));
});
afterEach(()=>{access?.dispose();vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();vi.restoreAllMocks();});

describe("fixed permit database connection",()=>{
  it.each(["PGOPTIONS","PGREPLICATION","PGSERVICE"])("rejects ambient %s before token, HTTP or pg construction",async name=>{
    vi.stubEnv(name,"fictional");
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_environment_invalid");
    expect(pg.clients).toHaveLength(0);expect(network).not.toHaveBeenCalled();expect(credential.getToken).not.toHaveBeenCalled();
  });
  it("also rejects an empty but present connection override",async()=>{
    vi.stubEnv("PGOPTIONS","");
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_environment_invalid");
    expect(pg.clients).toHaveLength(0);
  });
  it.each([
    {url:"postgresql://other:fictional@different.invalid/other"},
    {url:"postgresql://fixture:fictional@different.invalid/other?options=ignored"},
  ])("rejects a target substitution without connecting",async changed=>{
    await expect(connectPermitDatabase({...target,...changed},access,credential)).rejects.toThrow("trial_database_target_invalid");
    expect(pg.clients).toHaveLength(0);expect(network).not.toHaveBeenCalled();
  });
  it("requires verified TLS and reads actual server timeouts before exposing the client",async()=>{
    const connection=await connectPermitDatabase(target,access,credential);
    expect(pg.options[0]).toMatchObject({ssl:{rejectUnauthorized:true,servername:target.host},connectionTimeoutMillis:5000,
      statement_timeout:1000,query_timeout:1500,lock_timeout:500,idle_in_transaction_session_timeout:9000});
    expect(pg.clients[0].connect).toHaveBeenCalledOnce();
    const sql=pg.queries[0].mock.calls[0][0] as string;
    expect(sql).toContain("pg_stat_ssl");expect(sql).toContain("current_database()");expect(sql).toContain("current_user");
    for(const setting of ["statement_timeout","lock_timeout","idle_in_transaction_session_timeout"])expect(sql).toContain(`name='${setting}'`);
    await connection.close();await connection.close();expect(pg.clients[0].end).toHaveBeenCalledOnce();
  });
  it.each([
    {db:"different"},{usr:"different"},{tls:false},
    {statement_timeout_ms:0},{lock_timeout_ms:0},{idle_transaction_timeout_ms:0},
  ])("closes rather than returning a session whose readback differs: %j",async changed=>{
    pg.rows=[{...pg.rows[0],...changed}];
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_connection_unconfirmed");
    expect(pg.queries[0]).toHaveBeenCalledOnce();expect(pg.clients[0].end).toHaveBeenCalledOnce();
  });
  it("fails closed when the identity/settings row is missing",async()=>{
    pg.rows=[];
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_connection_unconfirmed");
    expect(pg.clients[0].end).toHaveBeenCalledOnce();
  });
  it("closes after an unknown readback failure without logging or returning remote errors",async()=>{
    pg.queryError=new Error("fictional remote detail");
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow(/^trial_database_connection_unconfirmed$/);
    expect(pg.clients[0].end).toHaveBeenCalledOnce();
  });
  it("permits at most twenty connections across sequential invocations without replenishment on close",async()=>{
    for(let i=0;i<20;i++){const connection=await connectPermitDatabase(target,access,credential);await connection.close();}
    const reads=network.mock.calls.length;
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_connection_limit");
    expect(pg.clients).toHaveLength(20);expect(network).toHaveBeenCalledTimes(reads);
  });
  it("charges failed connection attempts to the same process allowance",async()=>{
    pg.connectError=new Error("fictional connection failure");
    for(let i=0;i<20;i++)await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_connection_unconfirmed");
    await expect(connectPermitDatabase(target,access,credential)).rejects.toThrow("trial_database_connection_limit");
    expect(pg.clients).toHaveLength(20);expect(pg.clients.every(client=>client.end.mock.calls.length===1)).toBe(true);
  });
});
