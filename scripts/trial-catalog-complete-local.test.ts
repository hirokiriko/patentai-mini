import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "pg";
import { isolatedPg16 } from "./watch-report-local.test-support";
import { manualFixture } from "./koho-manual-import-fixtures";
import { fictionalManagedBase } from "./managed-base.test-support";
import { runTrialOperator } from "./trial-operator";
import { bootstrapTrialDatabase } from "../src/lib/trial/bootstrap";
import { CatalogAccess } from "../src/lib/trial/catalog-access";
import { CatalogAudit } from "../src/lib/trial/catalog-runtime";
import { connectPermitDatabase } from "../src/lib/trial/database-client";
import { installCountedSessionPermitReader } from "../src/lib/trial/database-permit";
import { OperatorAccess,operatorPolicyBinding,operatorTicketDigest,type OperatorTicket } from "../src/lib/trial/operator-access";
import { readTrialPolicy,TRIAL_START } from "../src/lib/trial/policy";
import { trialFixture,signedTrialEnvironment } from "../src/lib/trial/policy.test-support";
import { trialHash } from "../src/lib/trial/ledger";
import { ownerStorageBudget } from "../src/lib/trial/storage-budget";
import { CATALOG_PACK,CATALOG_QUERIES,CATALOG_QUERY_SET_SHA256,CATALOG_ROW_LIMIT,CATALOG_QUERY_BYTES,CATALOG_SNAPSHOT_BYTES,catalogDigest } from "../src/lib/trial/catalog-queries";
import { builtinManifestSchema,catalogPlanSchema,catalogSnapshotSchema,type BuiltinManifest } from "../src/lib/trial/catalog-schema";

const transport=vi.hoisted(()=>({
  local:undefined as undefined|{host:string;port:number;approvedHost:string},
  attempts:[] as {database:string;user:string;catalog:boolean}[],
  sql:[] as {text:string;database:string;catalog:boolean}[],
  snapshots:new Map<string,number>(),maxCatalogQueryRows:0,maxCatalogQueryBytes:0,maxCatalogSnapshotBytes:0,
}));
// Preserve the actual twenty-attempt production factory, identity query,
// DatabasePermit and query guards. Replace only its transport destination with
// the owned disposable PG16 container. The TLS field is fixture evidence only.
vi.mock("pg",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("pg")>();
  return {...actual,Client:class extends actual.Client{
    constructor(config:ConstructorParameters<typeof actual.Client>[0]){
      const input=typeof config==="object"&&config!==null?config:{};
      const url=typeof input.connectionString==="string"?new URL(input.connectionString):undefined;
      if(url){
        if(!transport.local||url.protocol!=="postgresql:"||url.hostname!==transport.local.approvedHost)throw Error("isolated_target_denied");
        const {connectionString:_ignored,...rest}=input;void _ignored;
        const database=decodeURIComponent(url.pathname.slice(1)),user=decodeURIComponent(url.username),catalog=typeof input.options==="string"&&input.options.includes("default_transaction_read_only=on");
        super({...rest,host:transport.local.host,port:transport.local.port,database,user,password:decodeURIComponent(url.password),ssl:false});
        transport.attempts.push({database,user,catalog});
        const query=this.query;
        Object.defineProperty(this,"query",{configurable:true,value:async(...args:unknown[])=>{
          const text=typeof args[0]==="string"?args[0]:(args[0] as {text:string}).text;
          transport.sql.push({text,database,catalog});
          const result=await Reflect.apply(query,this,args);
          if(text.startsWith("select current_database() as db,current_user as usr,")&&text.includes("pg_stat_ssl"))result.rows[0].tls=true;
          if(catalog){
            if(text==="BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")transport.snapshots.set(database,0);
            else if(text==="COMMIT"){
              transport.maxCatalogSnapshotBytes=Math.max(transport.maxCatalogSnapshotBytes,transport.snapshots.get(database)??0);transport.snapshots.delete(database);
            }else if(transport.snapshots.has(database)){
              const bytes=Buffer.byteLength(JSON.stringify(result.rows),"utf8");
              transport.maxCatalogQueryRows=Math.max(transport.maxCatalogQueryRows,result.rows.length);transport.maxCatalogQueryBytes=Math.max(transport.maxCatalogQueryBytes,bytes);
              transport.snapshots.set(database,transport.snapshots.get(database)!+bytes);
            }
          }
          return result;
        }});
      }else{
        if(input.host!=="127.0.0.1")throw Error("isolated_setup_target_denied");
        super(config);
      }
    }
  }};
});
vi.mock("../src/lib/trial/runtime",()=>({verifyTrialBuild:vi.fn(async()=>undefined)}));
vi.mock("./trial-owner-token",async(importOriginal)=>({
  ...await importOriginal<typeof import("./trial-owner-token")>(),
  trialOwnerCredential:()=>({getToken:async()=>({token:"fictional-memory-only",expiresOnTimestamp:Date.now()+3600000})}),
}));

/** Real SDK and trialStorageHttp, including its real SQL quota reservation,
 * commit proof and observation. Only the final fetch is replaced; no Cloud
 * request, CLI token, secret store or external endpoint is reachable. */
function memoryStorage(account:string,containers:string[]){
  const blobs=new Map<string,{bytes:Buffer;etag:string}>();let calls=0,revision=0;
  const fetch=vi.fn<typeof globalThis.fetch>(async(input,init)=>{
    const u=new URL(String(input)),method=init?.method??"GET",headers=new Headers(init?.headers);
    if(u.origin!==`https://${account}.blob.core.windows.net`||u.username||u.password||u.hash||
      !containers.includes(u.pathname.split("/")[1])||!["GET","HEAD","PUT"].includes(method))throw Error("fictional_storage_target_denied");
    calls++;
    const response=(status:number,bytes:Buffer,more:Record<string,string>={},head=false)=>new Response(head?null:new Uint8Array(bytes),{status,
      headers:{"content-length":String(bytes.length),"x-ms-request-id":"fictional-request","x-ms-version":"2023-11-03",...more}});
    const isContainer=u.searchParams.get("restype")==="container";
    if(isContainer){
      if(!["GET","HEAD"].includes(method)||u.pathname.split("/").length!==2)throw Error("fictional_container_contract");
      return response(200,Buffer.alloc(0),{etag:'"container"',"last-modified":"Sat, 17 Oct 2026 00:00:00 GMT"},method==="HEAD");
    }
    const old=blobs.get(u.pathname);
    if(method==="PUT"){
      if(headers.get("if-none-match")==="*"&&old)throw Error("fictional_blob_duplicate");
      if(headers.get("if-match")&&headers.get("if-match")!==old?.etag)throw Error("fictional_blob_etag");
      const body=init?.body;if(!(body instanceof Uint8Array))throw Error("fictional_blob_body");
      const etag=`"fixture-${++revision}"`;blobs.set(u.pathname,{bytes:Buffer.from(body),etag});
      return response(201,Buffer.alloc(0),{etag,"last-modified":"Sat, 17 Oct 2026 00:00:00 GMT"});
    }
    if(!old)throw Error("fictional_blob_missing");
    if(headers.get("if-match")&&headers.get("if-match")!==old.etag)throw Error("fictional_blob_etag");
    const common={etag:old.etag,"last-modified":"Sat, 17 Oct 2026 00:00:00 GMT","x-ms-blob-type":"BlockBlob"};
    if(method==="HEAD")return response(200,old.bytes,common,true);
    const range=/^bytes=(\d+)-(\d+)$/.exec(headers.get("x-ms-range")??headers.get("range")??"");
    if(range){const from=Number(range[1]),to=Number(range[2]);if(from<0||to>=old.bytes.length||to<from)throw Error("fictional_blob_range");
      return response(206,old.bytes.subarray(from,to+1),{...common,"content-range":`bytes ${from}-${to}/${old.bytes.length}`});}
    return response(200,old.bytes,common);
  });
  return{fetch,blobs,calls:()=>calls};
}

describe.skipIf(process.env.WATCH_REPORT_LOCAL_DB_TEST!=="1")("complete D=6 catalog/bootstrap/operator session on isolated PG16",()=>{
  let env:Awaited<ReturnType<typeof isolatedPg16>>,builtins:BuiltinManifest,directory:string;
  beforeEach(async()=>{
    env=await isolatedPg16(129);directory=await mkdtemp(join(tmpdir(),"catalog-complete-pg16-"));
    const password=(env.admin as unknown as {connectionParameters:{password:string}}).connectionParameters.password;
    const stock=new Client({host:env.connection.host,port:env.connection.port,database:"postgres",user:"postgres",password,
      options:"-c search_path=pg_catalog -c default_transaction_read_only=on"});await stock.connect();
    try{
      await stock.query(CATALOG_QUERIES.begin);
      const identity=(await stock.query(CATALOG_QUERIES.identity)).rows[0],inventory=(await stock.query(CATALOG_QUERIES.inventory)).rows;
      const data:Record<string,unknown>={};for(const key of CATALOG_PACK)data[key]=(await stock.query(CATALOG_QUERIES[key])).rows;
      const snapshot=catalogSnapshotSchema.parse({schema:1,identity,database:inventory.find(d=>d.datname===identity.database),...data});
      await stock.query(CATALOG_QUERIES.commit);data.roles=snapshot.roles.filter(r=>r.rolname==="postgres"||r.rolname.startsWith("pg_"));
      builtins=builtinManifestSchema.parse({schema:1,sourcePgVersion:identity.version,querySetSha256:CATALOG_QUERY_SET_SHA256,
        bootstrapSuperuserOid:snapshot.roles.find(r=>r.rolname==="postgres")!.oid,catalogs:data});
    }finally{await stock.end();}
    for(let i=0;i<3;i++)await env.sql(`CREATE DATABASE catalog_empty_${i} TEMPLATE template0`);
  },120000);
  afterEach(async()=>{
    transport.local=undefined;vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();
    await env?.cleanup();if(directory)await rm(directory,{recursive:true,force:true});
  },60000);
  it("uses exactly twenty attempts and measures all SQL permit GETs including real Storage accounting",async()=>{
    const p=structuredClone(trialFixture),start=Date.parse(TRIAL_START),began=performance.now(),iso=(n:number)=>new Date(n).toISOString();
    const now=()=>start+1000+performance.now()-began;vi.spyOn(Date,"now").mockImplementation(now);
    const id="11111111-1111-4111-8111-111111111111",salt=env.connection.database.slice(-16),prefix=`cc_${salt}`,adminUser=`ca_${salt}`;
    const adminPassword="fictional-catalog-complete-admin";
    await env.sql(`CREATE ROLE "${adminUser}" LOGIN CREATEDB CREATEROLE NOSUPERUSER NOINHERIT PASSWORD '${adminPassword}'`);
    await env.sql(`GRANT CONNECT ON DATABASE "${env.connection.database}" TO "${adminUser}"`);
    p.phase="initial";p.startsAt=iso(start);p.endsAt=iso(start+1800000);
    p.database={...p.database,database:prefix,ownerRole:prefix+"_owner",migratorUser:prefix+"_migrator",webUser:prefix+"_web",workerUser:prefix+"_worker"};
    p.samples=[1,2,3,4].map(caseId=>({caseId,from:"2026-01-01",through:"2026-01-31"}));
    p.cost={checkedAt:iso(start),validUntil:iso(start+3600000),normal:{inputYenPerMillion:100,outputYenPerMillion:200},
      mini:{inputYenPerMillion:10,outputYenPerMillion:20},initialOtherYen:100,retainedOtherYen:100,monthOtherYen:100,
      sharedRemainingYen:15000,jobYenPerHour:1,databaseBaselineBytes:0};
    const plan=catalogPlanSchema.parse({schema:1,server:p.database.host,adminUser,targetDatabase:prefix,
      roles:{owner:p.database.ownerRole,migrator:p.database.migratorUser,web:p.database.webUser,worker:p.database.workerUser},
      excludedDatabases:[{name:"template0",template:true,allowConnect:false}],maximumAuditConnections:6,
      builtinManifestSha256:catalogDigest(builtins),querySetSha256:CATALOG_QUERY_SET_SHA256,
      limits:{rowsPerQuery:CATALOG_ROW_LIMIT,bytesPerQuery:CATALOG_QUERY_BYTES,bytesPerSnapshot:CATALOG_SNAPSHOT_BYTES},
      bootstrapOwnerSet:{schema:1,kind:"temporary-owner-set-v1",authoritySha256:"b".repeat(64)}});
    const window={lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fixture",
      ruleId:`/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/guard`,
      journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:iso(start),useUntil:iso(start+600000)};
    const pkg=manualFixture("JPA",1,{publicationDate:"2026-01-11",issue:"2026-001"}),sample=fictionalManagedBase(),pkgPath=join(directory,"fictional.zip"),samplePath=join(directory,"fictional.xml");
    await writeFile(pkgPath,pkg,{flag:"wx"});await writeFile(samplePath,sample.bytes,{flag:"wx"});
    const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:iso(start),endsAt:iso(start+3600000),packages:[trialHash(pkg)],
      samples:p.samples.map(s=>({caseId:s.caseId,sha256:sample.source.sha256,key:`cases/${s.caseId}/prior-art/1700000000000-${id}-sample.xml`})),artifacts:[],databaseWindow:window};
    p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:trialHash(directory),catalogPlanDigest:catalogDigest(plan)};
    const signed=signedTrialEnvironment(p);delete(signed as Partial<typeof signed>).DATABASE_URL;
    const policy=readTrialPolicy(signed),clock={utc:now,monotonic:()=>performance.now()-began};
    const access=new OperatorAccess(ticket,policy,clock),catalogAccess=new CatalogAccess(signed,ticket,window,new AbortController().signal,clock);
    const credential={getToken:async()=>{throw Error("catalog_token_forbidden");}},adminUrl=`postgresql://${adminUser}:${adminPassword}@${p.database.host}/postgres`;
    transport.local={host:env.connection.host,port:env.connection.port,approvedHost:p.database.host};transport.attempts.length=0;transport.sql.length=0;
    transport.snapshots.clear();transport.maxCatalogQueryRows=0;transport.maxCatalogQueryBytes=0;transport.maxCatalogSnapshotBytes=0;
    let permitGets=0;
    const revoke=installCountedSessionPermitReader(window,async()=>{
      if(++permitGets>2800)throw Error("fixture_run_permit_budget_exhausted");const t=Math.floor(now());
      return{binding_digest:window.bindingDigest,lifecycle_id:id,rule_id:window.ruleId,cleanup_strategy:"single_job",status:"active",usage_allowed:true,
        close_requested:false,blocked:null,cloud_guard:{nonce:window.guardianNonce,job_started_at:window.jobStartedAt},cleanup_at:window.useUntil,
        use_lease_from:iso(t),use_lease_until:iso(Math.min(t+10000,Date.parse(window.useUntil)))};
    });
    const storage=memoryStorage(p.storage.account,Object.values(p.storage).filter(v=>v!==p.storage.account));vi.stubGlobal("fetch",storage.fetch);
    // Track and restore every environment field the production operator writes.
    for(const [key,value]of Object.entries(signed))vi.stubEnv(key,value);
    const audit=new CatalogAudit(plan,builtins,catalogAccess,adminUrl,directory,credential);
    const passwords={migratorPassword:"fictional-catalog-migrator",webPassword:"fictional-catalog-web",workerPassword:"fictional-catalog-worker"};
    let operatorCount=0,storageBudget:ReturnType<typeof ownerStorageBudget>|undefined;
    try{
      await audit.runPass(1);
      const boot=await bootstrapTrialDatabase({policy,access,recoveryDirectory:directory,credential,mode:"apply",
        manifest:{schema:1,adminCatalog:"postgres",adminUser,cases:p.samples.map(s=>({id:s.caseId,title:`FICTIONAL TRIAL SAMPLE ${s.caseId}`}))},
        credentials:{adminUrl,...passwords},beforeFirstWrite:async()=>{await audit.runPass(2);return audit.issueBootstrapCapability();}});
      expect(boot.status).toBe("bootstrapped");expect(boot.cases).toBe(4);expect(transport.attempts).toHaveLength(10);
      storageBudget=ownerStorageBudget(directory,access);
      const common={environment:signed,access:ticket,recoveryDirectory:directory,
        azureCliPython:process.platform==="win32"?join(directory,"python.exe"):"/fictional/python",
        databaseUrl:`postgresql://${p.database.migratorUser}:${passwords.migratorPassword}@${p.database.host}/${p.database.database}`};
      const run=async(request:unknown)=>{operatorCount++;return runTrialOperator({...common,request});};
      expect(await run({command:"initialize-ledger"})).toEqual({status:"initialized"});
      expect(await run({command:"package-import",sourcePath:pkgPath,sha256:trialHash(pkg)})).toEqual({status:"saved"});
      for(const s of p.samples){
        const saved=await run({command:"sample-save",caseId:s.caseId,sourcePath:samplePath,packageType:sample.source.packageType,
          entryPath:sample.source.entryPath,kind:sample.base.version,publicationNumber:sample.base.publicationNumber,
          publicationDate:sample.source.publicationDate,sha256:sample.source.sha256}) as {status:string;base:typeof sample.base;source:unknown};
        expect(saved.status).toBe("saved");
        expect(await run({command:"setting-save",setting:{caseId:s.caseId,contractSignedOn:"2025-12-01",monitoringStartsOn:s.from,
          contractEndsOn:s.through,enabled:true,base:saved.base,source:saved.source,selectedClaimNos:[1]}})).toEqual({status:"saved"});
      }
      await audit.runPass(3);
      const passes=await Promise.all([1,2,3].map(async pass=>JSON.parse(await readFile(join(directory,`trial-catalog-pass-${pass}.json`),"utf8"))));
      expect(operatorCount).toBe(10);expect(transport.attempts).toHaveLength(20);expect(transport.attempts.filter(a=>a.catalog)).toHaveLength(6);
      expect(transport.attempts.filter(a=>!a.catalog&&a.user===p.database.migratorUser)).toHaveLength(11);
      expect(passes.map(p=>p.counts.databases)).toEqual([6,6,6]);expect(passes.map(p=>p.counts.queries)).toEqual([114,114,114]);
      expect(passes[2].catalogDigest).toBe(passes[0].catalogDigest);expect(audit.result().auditConnectionAttempts).toBe(6);
      expect(transport.maxCatalogQueryRows).toBeLessThan(CATALOG_ROW_LIMIT);expect(transport.maxCatalogQueryBytes).toBeLessThan(CATALOG_QUERY_BYTES);
      expect(transport.maxCatalogSnapshotBytes).toBeLessThan(CATALOG_SNAPSHOT_BYTES);expect(transport.snapshots.size).toBe(0);
      expect(permitGets).toBeGreaterThanOrEqual(transport.sql.length);expect(permitGets).toBeLessThan(2800);
      expect(storage.calls()).toBeGreaterThan(0);expect(storageBudget.snapshot().requests).toBe(storage.calls());
      const getCount=permitGets,connectionCount=transport.attempts.length;
      await expect(connectPermitDatabase({url:adminUrl,host:p.database.host,database:"postgres",user:adminUser},access,credential)).rejects.toThrow("trial_database_connection_limit");
      expect(transport.attempts).toHaveLength(connectionCount);expect(permitGets).toBe(getCount);
      process.stdout.write("CATALOG_COMPLETE_METRICS "+JSON.stringify({auditDatabases:6,connectionAttempts:transport.attempts.length,operatorCommands:operatorCount,
        permitGets,permitRunAllowance:2800,permitHeadroom:2800-permitGets,sqlSends:transport.sql.length,storageRequests:storage.calls(),
        catalogPasses:passes.map(p=>p.counts),maxCatalogQueryRows:transport.maxCatalogQueryRows,maxCatalogQueryBytes:transport.maxCatalogQueryBytes,
        maxCatalogSnapshotBytes:transport.maxCatalogSnapshotBytes,packageBytes:pkg.length,cloudRequests:0})+"\n");
    }finally{storageBudget?.close();revoke();await audit.close();catalogAccess.dispose();access.dispose();}
  },180000);
});

it("permits only the SDK's bounded optional container timeout, never query expansion",()=>{
  const p=structuredClone(trialFixture),start=Date.parse(TRIAL_START),iso=(n:number)=>new Date(n).toISOString();
  const ticket:OperatorTicket={schema:1,id:"11111111-1111-4111-8111-111111111111",policyDigest:operatorPolicyBinding(p),
    startsAt:iso(start),endsAt:iso(start+3600000),packages:[],samples:[],artifacts:[]};
  p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:"a".repeat(64)};
  const access=new OperatorAccess(ticket,p,{utc:()=>start+1000,monotonic:()=>0}),url=`https://${p.storage.account}.blob.core.windows.net/${p.storage.budget}`;
  try{
    for(const query of ["restype=container","restype=container&timeout=1","timeout=20&restype=container"])
      for(const method of ["GET","HEAD"])expect(()=>access.storage("budget",url+"?"+query,method)).not.toThrow();
    for(const query of ["timeout=20","restype=blob","restype=container&timeout=0","restype=container&timeout=21",
      "restype=container&timeout=1&timeout=1","restype=container&restype=container","restype=container&comp=list","restype=container&sig=fictional"])
      expect(()=>access.storage("budget",url+"?"+query,"GET")).toThrow("trial_operator_target_denied");
    expect(()=>access.storage("budget",url+"?restype=container&timeout=20","PUT")).toThrow("trial_operator_target_denied");
  }finally{access.dispose();}
});
