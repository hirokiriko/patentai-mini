import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { bootstrapTrialDatabase } from "../src/lib/trial/bootstrap";
import { CatalogAccess } from "../src/lib/trial/catalog-access";
import { CatalogAudit } from "../src/lib/trial/catalog-runtime";
import { connectPermitDatabase } from "../src/lib/trial/database-client";
import { DatabasePermit,guardDatabasePermit } from "../src/lib/trial/database-permit";
import { OperatorAccess,guardOperatorDatabase,operatorPolicyBinding,operatorTicketDigest,type OperatorTicket } from "../src/lib/trial/operator-access";
import { readTrialPolicy,TRIAL_START } from "../src/lib/trial/policy";
import { trialFixture,signedTrialEnvironment } from "../src/lib/trial/policy.test-support";
import { trialHash } from "../src/lib/trial/ledger";
import { CATALOG_PACK,CATALOG_QUERIES,CATALOG_QUERY_SET_SHA256,CATALOG_ROW_LIMIT,CATALOG_QUERY_BYTES,CATALOG_SNAPSHOT_BYTES,catalogDigest } from "../src/lib/trial/catalog-queries";
import { builtinManifestSchema,catalogPlanSchema,catalogSnapshotSchema,type BuiltinManifest } from "../src/lib/trial/catalog-schema";

vi.mock("../src/lib/trial/database-client",()=>({connectPermitDatabase:vi.fn()}));
// The transport target alone is replaced with an isolated localhost PG16.
// CatalogAccess, capability, all passes and guarded SQL are real code paths.
describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST!=="1")("catalog admitted non-superuser bootstrap on isolated PG16",()=>{
  let env:Awaited<ReturnType<typeof isolatedPg16>>,builtins:BuiltinManifest,adminUser:string;
  const adminPassword="fictional-catalog-bootstrap-admin-only",dirs:string[]=[];
  beforeEach(async()=>{
    env=await isolatedPg16(129);
    const password=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    const stock=new Client({host:env.connection.host,port:env.connection.port,database:"postgres",user:"postgres",password,
      options:"-c search_path=pg_catalog -c default_transaction_read_only=on"});await stock.connect();
    try{
      await stock.query(CATALOG_QUERIES.begin);
      const identity=(await stock.query(CATALOG_QUERIES.identity)).rows[0],inventory=(await stock.query(CATALOG_QUERIES.inventory)).rows;
      const data:Record<string,unknown>={};for(const key of CATALOG_PACK)data[key]=(await stock.query(CATALOG_QUERIES[key])).rows;
      const snapshot=catalogSnapshotSchema.parse({schema:1,identity,database:inventory.find(d=>d.datname===identity.database),...data});
      await stock.query(CATALOG_QUERIES.commit);
      data.roles=snapshot.roles.filter(r=>r.rolname==="postgres"||r.rolname.startsWith("pg_"));
      builtins=builtinManifestSchema.parse({schema:1,sourcePgVersion:identity.version,querySetSha256:CATALOG_QUERY_SET_SHA256,
        bootstrapSuperuserOid:snapshot.roles.find(r=>r.rolname==="postgres")!.oid,catalogs:data});
    }finally{await stock.end();}
    adminUser=`catalog_admin_${env.connection.database.slice(-16)}`;
    await env.sql(`CREATE ROLE "${adminUser}" LOGIN CREATEDB CREATEROLE NOSUPERUSER NOINHERIT PASSWORD '${adminPassword}'`);
    // Only this isolated fixture administrator receives CONNECT to the fixture
    // business DB. No row grants or live target are involved in test setup.
    await env.sql(`GRANT CONNECT ON DATABASE "${env.connection.database}" TO "${adminUser}"`);
  },120000);
  afterEach(async()=>{await env?.cleanup();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});},60000);
  async function fixture(suffix:string,approved:boolean,loseCreateAck=false){
    const p=structuredClone(trialFixture),start=Date.parse(TRIAL_START),began=performance.now();
    const iso=(n:number)=>new Date(n).toISOString(),id="11111111-1111-4111-8111-111111111111",prefix=`cb_${suffix}_${env.connection.database.slice(-16)}`;
    p.phase="initial";p.startsAt=iso(start);p.endsAt=iso(start+1800000);
    p.database={...p.database,database:prefix,ownerRole:prefix+"_owner",migratorUser:prefix+"_migrator",webUser:prefix+"_web",workerUser:prefix+"_worker"};
    p.cost={checkedAt:iso(start),validUntil:iso(start+3600000),normal:{inputYenPerMillion:100,outputYenPerMillion:200},
      mini:{inputYenPerMillion:10,outputYenPerMillion:20},initialOtherYen:100,retainedOtherYen:100,monthOtherYen:100,
      sharedRemainingYen:100,jobYenPerHour:1,databaseBaselineBytes:0};
    const plan=catalogPlanSchema.parse({schema:1,server:p.database.host,adminUser,targetDatabase:prefix,
      roles:{owner:p.database.ownerRole,migrator:p.database.migratorUser,web:p.database.webUser,worker:p.database.workerUser},
      excludedDatabases:[{name:"template0",template:true,allowConnect:false}],maximumAuditConnections:6,
      builtinManifestSha256:catalogDigest(builtins),querySetSha256:CATALOG_QUERY_SET_SHA256,
      limits:{rowsPerQuery:CATALOG_ROW_LIMIT,bytesPerQuery:CATALOG_QUERY_BYTES,bytesPerSnapshot:CATALOG_SNAPSHOT_BYTES},
      ...(approved?{bootstrapOwnerSet:{schema:1,kind:"temporary-owner-set-v1",authoritySha256:"b".repeat(64)}}:{})});
    const directory=await mkdtemp(join(tmpdir(),"catalog-bootstrap-pg16-"));dirs.push(directory);
    const window={lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fixture",
      ruleId:`/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/guard`,
      journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:iso(start),useUntil:iso(start+600000)};
    const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:iso(start),endsAt:iso(start+3600000),packages:[],samples:[],artifacts:[],databaseWindow:window};
    p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:trialHash(directory),catalogPlanDigest:catalogDigest(plan)};
    const signed=signedTrialEnvironment(p),policy=readTrialPolicy(signed),now=()=>start+1000+performance.now()-began;
    const clock={utc:now,monotonic:()=>performance.now()-began};
    const access=new OperatorAccess(ticket,policy,clock),catalogAccess=new CatalogAccess(signed,ticket,window,new AbortController().signal,clock);
    const sends:{sql:string;user:string;database:string;catalog:boolean}[]=[],attempts:{user:string;database:string;catalog:boolean}[]=[],grantSnapshots:unknown[][]=[];
    const auditDatabases=(await env.sql("SELECT datname FROM pg_catalog.pg_database WHERE datallowconn ORDER BY datname")).map(r=>String(r.datname));
    const members=async()=>env.sql(`SELECT pg_catalog.pg_get_userbyid(m.grantor) AS grantor,m.admin_option,m.inherit_option,m.set_option
      FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member
      WHERE r.rolname=$1 AND u.rolname=$2 ORDER BY m.grantor`,[plan.roles.owner,adminUser]);
    const grantSql=`GRANT "${plan.roles.owner}" TO "${adminUser}"`,createSql=`CREATE DATABASE "${prefix}"`;let lost=false;
    vi.mocked(connectPermitDatabase).mockImplementation(async(target,givenAccess)=>{
      const catalog=target.catalogOnly===true;
      if(target.host!==policy.database.host||(catalog?givenAccess!==catalogAccess||target.user!==adminUser||!auditDatabases.includes(target.database):
        givenAccess!==access||!["postgres",prefix].includes(target.database)||![adminUser,...Object.values(plan.roles)].includes(target.user)))throw Error("isolated_target_denied");
      if(attempts.length>=20)throw Error("isolated_attempt_limit");attempts.push({user:target.user,database:target.database,catalog});
      const url=new URL(target.url),client=new Client({host:env.connection.host,port:env.connection.port,database:target.database,user:target.user,
        password:target.user===adminUser?adminPassword:decodeURIComponent(url.password),ssl:false,connectionTimeoutMillis:1000,
        statement_timeout:1000,query_timeout:1500,lock_timeout:500,idle_in_transaction_session_timeout:9000,
        ...(catalog?{options:"-c search_path=pg_catalog -c default_transaction_read_only=on"}:{})});
      client.on("error",()=>undefined);const original=client.query;
      Object.defineProperty(client,"query",{configurable:true,value:async(...args:unknown[])=>{
        const sql=typeof args[0]==="string"?args[0]:(args[0] as {text:string}).text;sends.push({sql,user:target.user,database:target.database,catalog});
        const result=await Reflect.apply(original,client,args);
        if(sql.startsWith(grantSql))grantSnapshots.push(await members());
        if(loseCreateAck&&!lost&&sql.startsWith(createSql)){lost=true;throw Error("fixture_create_ack_lost");}return result;
      }});
      const detach=guardOperatorDatabase(client,givenAccess),permit=new DatabasePermit(givenAccess,async()=>{
        const t=Math.floor(now());return{binding_digest:window.bindingDigest,lifecycle_id:id,rule_id:window.ruleId,cleanup_strategy:"single_job",
          status:"active",usage_allowed:true,close_requested:false,blocked:null,cloud_guard:{nonce:"fixture",job_started_at:window.jobStartedAt},
          cleanup_at:window.useUntil,use_lease_from:iso(t),use_lease_until:iso(Math.min(t+10000,Date.parse(window.useUntil)))};
      },()=>client.end());guardDatabasePermit(client,permit);
      let closing:Promise<void>|undefined;const close=()=>closing??=(async()=>{permit.dispose();detach();await client.end().catch(()=>undefined);})();
      try{await permit.refresh();permit.assertSend();await client.connect();return{client,close};}catch(e){await close();throw e;}
    });
    const adminUrl=`postgresql://${adminUser}:${adminPassword}@${policy.database.host}/postgres`,credential={getToken:async()=>{throw Error("isolated_token_forbidden");}};
    const makeAudit=(input:unknown)=>new CatalogAudit(input,builtins,catalogAccess,adminUrl,directory,credential),audit=makeAudit(plan);
    const options={policy,access,recoveryDirectory:directory,credential,mode:"apply" as const,
      manifest:{schema:1 as const,adminCatalog:"postgres" as const,adminUser,cases:[{id:1,title:"FICTIONAL TRIAL SAMPLE 1"}]},
      credentials:{adminUrl,migratorPassword:"fictional-catalog-migrator",webPassword:"fictional-catalog-web",workerPassword:"fictional-catalog-worker"},
      beforeFirstWrite:async()=>{await audit.runPass(2);return audit.issueBootstrapCapability();}};
    const cleanup=async()=>{await audit.close();catalogAccess.dispose();access.dispose();};
    return{plan,policy,directory,audit,options,makeAudit,sends,attempts,members,grantSnapshots,cleanup};
  }
  const mutations=(sends:{sql:string}[])=>sends.filter(q=>/^\s*(create|alter|grant|revoke|insert|update|delete|truncate|drop)\b/i.test(q.sql));
  const automatic=()=>({grantor:"postgres",admin_option:true,inherit_option:false,set_option:false});
  const temporary=()=>({grantor:adminUser,admin_option:false,inherit_option:false,set_option:true});
  it("requires explicit signed authority before DDL and completes all three real passes with only a temporary SET grant",async()=>{
    const denied=await fixture("denied",false);
    try{
      expect(()=>denied.makeAudit({...denied.plan,bootstrapOwnerSet:{schema:1,kind:"temporary-owner-set-v1",authoritySha256:"b".repeat(64)}})).toThrow();
      expect(denied.attempts).toHaveLength(0);await denied.audit.runPass(1);
      await expect(bootstrapTrialDatabase(denied.options)).rejects.toThrow();expect(mutations(denied.sends)).toHaveLength(0);
      expect(await env.sql("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])",[Object.values(denied.plan.roles)])).toEqual([]);
      expect(await env.sql("SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",[denied.plan.targetDatabase])).toEqual([]);
    }finally{await denied.cleanup();}
    const f=await fixture("accepted",true);
    try{
      expect(()=>f.makeAudit({...f.plan,bootstrapOwnerSet:{...f.plan.bootstrapOwnerSet!,authoritySha256:"c".repeat(64)}})).toThrow();expect(f.attempts).toHaveLength(0);
      await f.audit.runPass(1);const result=await bootstrapTrialDatabase(f.options);
      expect(result.status).toBe("bootstrapped");expect(result.databaseBaselineBytes).toBeGreaterThan(0);await f.audit.runPass(3);
      expect(f.audit.result().auditPlanDigest).toBe(catalogDigest(f.plan));expect(f.grantSnapshots).toEqual([[automatic(),temporary()]]);expect(await f.members()).toEqual([automatic()]);
      const first=JSON.parse(await readFile(join(f.directory,"trial-catalog-pass-1.json"),"utf8")),third=JSON.parse(await readFile(join(f.directory,"trial-catalog-pass-3.json"),"utf8"));
      expect(third.catalogDigest).toBe(first.catalogDigest);expect(third.targetInventoryDigest).toBe(first.targetInventoryDigest);
      expect(f.attempts.filter(a=>a.catalog)).toHaveLength(first.auditConnectionAttempts);expect(f.attempts.filter(a=>!a.catalog)).toHaveLength(4);expect(f.attempts.length).toBeLessThanOrEqual(20);
      const grant=f.sends.findIndex(q=>q.sql.startsWith(`GRANT "${f.plan.roles.owner}" TO "${adminUser}"`)),create=f.sends.findIndex(q=>q.sql.startsWith(`CREATE DATABASE "${f.plan.targetDatabase}"`));
      const revoke=f.sends.findIndex(q=>q.sql.startsWith(`REVOKE "${f.plan.roles.owner}" FROM "${adminUser}"`)),acl=f.sends.findIndex(q=>q.sql.startsWith(`GRANT CONNECT ON DATABASE "${f.plan.targetDatabase}"`));
      expect(grant).toBeGreaterThanOrEqual(0);expect(create).toBeGreaterThan(grant);expect(revoke).toBeGreaterThan(create);expect(acl).toBeGreaterThan(revoke);
      expect(f.sends[acl].user).toBe(f.plan.roles.migrator);expect(f.sends[acl].database).toBe(f.plan.targetDatabase);
      expect(f.sends[grant].sql).toContain(`GRANTED BY "${adminUser}"`);expect(f.sends[revoke].sql).toContain(`GRANTED BY "${adminUser}" RESTRICT`);
      const count=mutations(f.sends).length;await expect(bootstrapTrialDatabase(f.options)).rejects.toThrow();expect(mutations(f.sends)).toHaveLength(count);expect(await f.members()).toEqual([automatic()]);
    }finally{await f.cleanup();}
  },120000);
  it("does not queue cleanup SQL or resend a CREATE after its real acknowledgement is lost",async()=>{
    const f=await fixture("lostack",true,true);
    try{
      await f.audit.runPass(1);await expect(bootstrapTrialDatabase(f.options)).rejects.toThrow();expect(f.grantSnapshots).toEqual([[automatic(),temporary()]]);expect(await f.members()).toEqual([automatic(),temporary()]);
      expect(await env.sql("SELECT datname FROM pg_catalog.pg_database WHERE datname=$1",[f.plan.targetDatabase])).toHaveLength(1);
      const create=f.sends.findIndex(q=>q.sql.startsWith(`CREATE DATABASE "${f.plan.targetDatabase}"`));expect(create).toBeGreaterThanOrEqual(0);expect(f.sends.slice(create+1)).toEqual([]);expect(()=>f.audit.result()).toThrow();
      const count=mutations(f.sends).length;await expect(bootstrapTrialDatabase(f.options)).rejects.toThrow();expect(mutations(f.sends)).toHaveLength(count);
      expect(f.sends.filter(q=>q.sql.startsWith(`CREATE DATABASE "${f.plan.targetDatabase}"`))).toHaveLength(1);
      expect(f.sends.filter(q=>q.sql.startsWith(`REVOKE "${f.plan.roles.owner}" FROM "${adminUser}"`))).toHaveLength(0);expect(await f.members()).toEqual([automatic(),temporary()]);
    }finally{await f.cleanup();}
  },120000);
});
