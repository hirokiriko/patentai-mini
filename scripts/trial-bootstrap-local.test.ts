import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { bootstrapTrialDatabase } from "../src/lib/trial/bootstrap";
import { connectPermitDatabase } from "../src/lib/trial/database-client";
import { DatabasePermit, guardDatabasePermit } from "../src/lib/trial/database-permit";
import { OperatorAccess, operatorPolicyBinding, operatorTicketDigest, guardOperatorDatabase, type OperatorTicket } from "../src/lib/trial/operator-access";
import { trialFixture,signedTrialEnvironment } from "../src/lib/trial/policy.test-support";
import { TRIAL_START } from "../src/lib/trial/policy";
import { trialHash } from "../src/lib/trial/ledger";
import { inspectTrialCloudDatabase } from "../src/lib/patent-watch/managed-cloud-db";
import { TrialNetworkBudget } from "../src/lib/trial/network-budget";
vi.mock("../src/lib/trial/database-client",()=>({connectPermitDatabase:vi.fn()}));

/** Uses only the existing isolated localhost PG16 helper (--pull never).
 * The production factory is replaced solely here: no Azure URL is contacted,
 * and plaintext loopback tests are NOT evidence of live TLS/authentication. */
describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST!=="1")("trial bootstrap isolated PG16",()=>{
  let env:Awaited<ReturnType<typeof isolatedPg16>>;
  const dirs:string[]=[];
  beforeAll(async()=>{env=await isolatedPg16(129);},120000);
  afterAll(async()=>{await env?.cleanup();for(const dir of dirs)await rm(dir,{recursive:true,force:true});},60000);
  afterEach(()=>vi.unstubAllEnvs());
  async function fixture(suffix:string){
    const p=structuredClone(trialFixture),id="11111111-1111-4111-8111-111111111111",start=Date.parse(TRIAL_START),began=performance.now();
    const salt=env.connection.database.slice(-16),prefix=`bt_${suffix}_${salt}`;
    p.database={...p.database,database:prefix,ownerRole:prefix+"_owner",migratorUser:prefix+"_migrator",webUser:prefix+"_web",workerUser:prefix+"_worker"};
    const dir=await mkdtemp(join(tmpdir(),"trial-bootstrap-pg16-"));dirs.push(dir);
    const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),packages:[],samples:[],artifacts:[],
      databaseWindow:{lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fixture",ruleId:`/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/guard`,
        journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:new Date(start).toISOString(),useUntil:new Date(start+600000).toISOString()}};
    p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:trialHash(dir)};
    let offset=0,alive=true,loseCommit=false;
    const now=()=>start+1000+performance.now()-began+offset;
    const access=new OperatorAccess(ticket,p,{utc:now,monotonic:()=>performance.now()-began+offset});
    const sends:string[]=[],attempts:string[]=[];
    const adminPassword=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    const localClient=async(user:string,database:string,password:string)=>{
      const client=new Client({host:env.connection.host,port:env.connection.port,database,user,password,ssl:false,
        connectionTimeoutMillis:1000,statement_timeout:1000,query_timeout:1500,lock_timeout:500,idle_in_transaction_session_timeout:9000});
      client.on("error",()=>undefined);return client;
    };
    vi.mocked(connectPermitDatabase).mockImplementation(async(target,givenAccess)=>{
      if(givenAccess!==access||target.host!==p.database.host||!["postgres",p.database.database].includes(target.database))throw Error("isolated_target_denied");
      attempts.push(target.user);
      const url=new URL(target.url),client=await localClient(target.user,target.database,target.user==="postgres"?adminPassword:decodeURIComponent(url.password));
      const query=client.query;
      Object.defineProperty(client,"query",{configurable:true,value:async function(...args:unknown[]){
        const text=typeof args[0]==="string"?args[0]:(args[0] as {text:string}).text;
        sends.push(text);
        const result=await Reflect.apply(query,client,args);
        if(loseCommit&&/^\s*commit\s*$/i.test(text)){loseCommit=false;throw Error("fixture_ack_lost");}
        return result;
      }});
      const detach=guardOperatorDatabase(client,access);
      const permit=new DatabasePermit(access,async()=>{const leaseNow=Math.floor(now());return{binding_digest:ticket.databaseWindow!.bindingDigest,lifecycle_id:id,rule_id:ticket.databaseWindow!.ruleId,
        cleanup_strategy:"single_job",status:"active",usage_allowed:alive,close_requested:false,blocked:null,
        cloud_guard:{nonce:"fixture",job_started_at:ticket.databaseWindow!.jobStartedAt},cleanup_at:ticket.databaseWindow!.useUntil,
        use_lease_from:new Date(leaseNow).toISOString(),use_lease_until:new Date(Math.min(leaseNow+10000,Date.parse(ticket.databaseWindow!.useUntil))).toISOString()};},()=>client.end());
      guardDatabasePermit(client,permit);
      const close=async()=>{permit.dispose();detach();await client.end().catch(()=>undefined);};
      try{await permit.refresh();permit.assertSend();await client.connect();return{client,close};}catch(e){await close();throw e;}
    });
    return {policy:p,access,recoveryDirectory:dir,manifest:{schema:1 as const,adminCatalog:"postgres" as const,adminUser:"postgres",cases:[{id:1,title:"FICTIONAL TRIAL SAMPLE 1"}]},
      credentials:{adminUrl:`postgresql://postgres:fictional-admin-only@${p.database.host}/postgres`,migratorPassword:"fictional-%27'-migrator-only",webPassword:"fictional-%40-web-only",workerPassword:"fictional-colon:@-worker-only"},
      credential:{getToken:async()=>({token:"fixture"})},mode:"apply" as "apply"|"reconcile",sends,attempts,localClient,
      loseNextCommit:()=>{loseCommit=true;},withdraw:()=>{alive=false;},expire:()=>{offset=600000;}};
  }
  it("creates only dedicated objects, migrates through guarded queries, preserves the fixture DB and denies runtime DDL/corpus writes",async()=>{
    const f=await fixture("complete");
    try{
      const before=(await env.sql("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")).at(0)!.n;
      const result=await bootstrapTrialDatabase(f);
      expect(result.status).toBe("bootstrapped");expect(result.databaseBaselineBytes).toBeGreaterThan(0);expect(f.attempts).toHaveLength(4);
      expect(f.sends.some(q=>/^\s*begin\s*$/i.test(q))).toBe(true);expect(f.sends.some(q=>/^\s*commit\s*$/i.test(q))).toBe(true);
      expect((await env.sql("select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'")).at(0)!.n).toBe(before);
      const web=await f.localClient(f.policy.database.webUser,f.policy.database.database,f.credentials.webPassword);await web.connect();
      try{
        expect((await web.query("select title from cases where case_id=1")).rows[0].title).toBe("FICTIONAL TRIAL SAMPLE 1");
        expect((await web.query("insert into cases(title) values('FICTIONAL NEW CASE') returning case_id")).rows[0].case_id).toBe(2);
        await expect(web.query("create table public.bootstrap_forbidden(n int)")).rejects.toMatchObject({code:"42501"});
        await expect(web.query("delete from cases where case_id=1")).rejects.toMatchObject({code:"42501"});
        await expect(web.query("insert into koho_import_runs(package_type,source_sha256) values('JPA','fixture')")).rejects.toMatchObject({code:"42501"});
        await expect(web.query(`SET ROLE "${f.policy.database.ownerRole}"`)).rejects.toMatchObject({code:"42501"});
        for(const[k,v]of Object.entries(signedTrialEnvironment(f.policy)))vi.stubEnv(k,v);
        const budget=new TrialNetworkBudget(f.policy,web),request={service:"blob" as const,purpose:"budget" as const,method:"GET" as const,requestBytes:0,responseLimit:4096};
        const reservation=await budget.reserve(request);await reservation.observed(12,200);
        expect((await web.query("select requests,reserved_bytes::text as bytes from trial_network_budget where service='blob' and slot=0")).rows[0]).toEqual({requests:1,bytes:"4096"});
        await expect(web.query("update trial_network_budget set binding=repeat('a',64)")).rejects.toMatchObject({code:"42501"});
        await expect(web.query("delete from trial_network_budget")).rejects.toMatchObject({code:"42501"});
        await web.query("BEGIN");
        await expect(budget.reserve({...request,service:"arm",purpose:"job"})).rejects.toThrow("trial_network_budget_unavailable");
        await web.query("ROLLBACK");
        expect((await web.query("select requests from trial_network_budget where service='arm' and slot=0")).rows[0].requests).toBe(0);
        const second=await f.localClient(f.policy.database.webUser,f.policy.database.database,f.credentials.webPassword);await second.connect();
        try{
          await web.query("update trial_network_budget set requests=3402 where service='blob' and slot=0");
          const results=await Promise.allSettled([budget.reserve(request),new TrialNetworkBudget(f.policy,second).reserve(request)]);
          expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
          await expect(new TrialNetworkBudget(f.policy,second).reserve(request)).rejects.toThrow();
        }finally{await second.end();}
      }finally{await web.end();}
      const worker=await f.localClient(f.policy.database.workerUser,f.policy.database.database,f.credentials.workerPassword);await worker.connect();
      try{
        // Only the TLS field is supplied by the fixture. All effective role,
        // table, column, sequence and schema ACL evidence comes from real PG16.
        const aclClient={query:async(text:string,values?:unknown[])=>{const result=await worker.query(text,values);
          if(text.includes("pg_stat_ssl"))result.rows[0].tls=true;return result;}} as unknown as Client;
        await expect(inspectTrialCloudDatabase(aclClient,{host:f.policy.database.host,port:5432,database:f.policy.database.database,user:f.policy.database.workerUser})).resolves.toBeUndefined();
        await expect(worker.query("insert into managed_watch_job_starts(operation_id) values('forbidden')")).rejects.toMatchObject({code:"42501"});
        await expect(worker.query("update managed_watch_findings set review_status='reviewed'")).rejects.toMatchObject({code:"42501"});
      }finally{await worker.end();}
    }finally{f.access.dispose();}
  },120000);
  it("never resends a migration after lost COMMIT acknowledgement; read-only reconcile permits later unsent steps",async()=>{
    const f=await fixture("unknown");f.loseNextCommit();
    try{
      await expect(bootstrapTrialDatabase(f)).rejects.toThrow("trial_bootstrap_failed_migrations");
      const count=()=>f.sends.filter(q=>/^\s*(create|alter|grant|revoke|insert|commit)\b/i.test(q)).length;
      const first=count();
      await expect(bootstrapTrialDatabase(f)).rejects.toThrow("reconciliation_required");expect(count()).toBe(first);
      await expect(bootstrapTrialDatabase({...f,mode:"reconcile"})).rejects.toThrow("reconciliation_required");expect(count()).toBe(first);
      const result=await bootstrapTrialDatabase(f);expect(result.status).toBe("bootstrapped");
      expect(f.sends.filter(q=>/^\s*commit\s*$/i.test(q))).toHaveLength(1);
    }finally{f.access.dispose();}
  },120000);
  it("rejects a withdrawn guardian before any DDL",async()=>{
    const f=await fixture("withdrawn");f.withdraw();
    try{await expect(bootstrapTrialDatabase(f)).rejects.toThrow("permit_unavailable");expect(f.sends).toHaveLength(0);}
    finally{f.access.dispose();}
  });
  it("rejects PUBLIC column grants in a business schema beginning pg without changing that ACL",async()=>{
    const f=await fixture("column"),secret=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    const setup=await f.localClient("postgres","postgres",secret);await setup.connect();
    try{
      await setup.query("create schema pgdata");await setup.query("create table pgdata.fixture_private(id int)");
      await setup.query("grant select(id) on pgdata.fixture_private to public");
      await expect(bootstrapTrialDatabase(f)).rejects.toThrow("shared_acl_hazard");
      expect(f.sends.some(q=>/^\s*(create|alter|grant|revoke|insert)\b/i.test(q))).toBe(false);
      expect((await setup.query("select exists(select 1 from pg_attribute a,lateral aclexplode(a.attacl) x where a.attrelid='pgdata.fixture_private'::regclass and x.grantee=0) as preserved")).rows[0].preserved).toBe(true);
    }finally{await setup.end();f.access.dispose();}
  });
});
