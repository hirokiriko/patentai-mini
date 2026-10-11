import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trialFixture } from "./policy.test-support";
import { OperatorAccess, operatorPolicyBinding, operatorTicketDigest, type OperatorTicket } from "./operator-access";
import { trialHash } from "./ledger";
import { TRIAL_START } from "./policy";
import { bootstrapTrialDatabase, bootstrapManifestSchema } from "./bootstrap";
import { connectPermitDatabase } from "./database-client";
vi.mock("./database-client",()=>({connectPermitDatabase:vi.fn()}));
// This suite tests the installer after the catalog boundary. The real one-use
// capability and all three catalog passes have their own integration coverage.
vi.mock("./catalog-runtime",()=>({consumeCatalogBootstrapCapability:vi.fn(()=>({mode:"native-superuser",adminUser:"admin_user",adminOid:10}))}));

const pending:{dir:string;access:OperatorAccess}[]=[];
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"trial-bootstrap-unit-")),p=structuredClone(trialFixture),start=Date.parse(TRIAL_START),id="11111111-1111-4111-8111-111111111111";
  p.database.ownerRole="trial_owner";p.database.migratorUser="trial_migrator";
  let clock=start+1000;
  const ticket:OperatorTicket={schema:1,id,policyDigest:operatorPolicyBinding(p),startsAt:new Date(start).toISOString(),endsAt:new Date(start+3600000).toISOString(),packages:[],samples:[],artifacts:[],
    databaseWindow:{lifecycleId:id,bindingDigest:"a".repeat(64),guardianNonce:"fixture",ruleId:`/subscriptions/${id}/resourceGroups/fixture/providers/Microsoft.DBforPostgreSQL/flexibleServers/fixture/firewallRules/guard`,
      journalUrl:`https://${p.storage.account}.blob.core.windows.net/guard/state.json`,jobStartedAt:new Date(start).toISOString(),useUntil:new Date(start+600000).toISOString()}};
  p.localOperator={ticketDigest:operatorTicketDigest(ticket),recoveryDirectoryDigest:trialHash(dir)};
  const access=new OperatorAccess(ticket,p,{utc:()=>clock,monotonic:()=>clock-start});pending.push({dir,access});
  return{policy:p,access,recoveryDirectory:dir,manifest:{schema:1 as const,adminCatalog:"postgres" as const,adminUser:"admin_user",cases:[{id:1,title:"FICTIONAL TRIAL SAMPLE 1"}]},
    credentials:{adminUrl:`postgresql://admin_user:fictional-admin-only@${p.database.host}/postgres`,migratorPassword:"fictional-migrator-only",webPassword:"fictional-web-only",workerPassword:"fictional-worker-only"},
    credential:{getToken:async()=>({token:"fixture"})},beforeFirstWrite:async()=>({} as never),mode:"apply" as "apply"|"reconcile",advance:(milliseconds:number)=>{clock+=milliseconds;}};
}
afterEach(async()=>{vi.clearAllMocks();for(const f of pending.splice(0)){f.access.dispose();await rm(f.dir,{recursive:true,force:true});}});
function catalog(options:{occupied?:boolean;publicHazard?:boolean;lostAck?:boolean;beforeCreate?:()=>Promise<void>}={}){
  const created=new Set<string>(),sent:string[]=[];
  const query=vi.fn(async(text:string,values?:unknown[])=>{
    sent.push(text);
    if(text.includes("server_version_num"))return{rows:[{major:16,strings:"on"}]};
    if(text==="select rolname from pg_roles where rolname=any($1::text[])")return{rows:[...(options.occupied?[{rolname:"trial_owner"}]:[]),...Array.from(created).map(rolname=>({rolname}))]};
    if(text.includes("from pg_database where datname=$1"))return{rows:[]};
    if(text.includes("count(*)::int as n"))return{rows:[{n:options.publicHazard?1:0}]};
    if(text.startsWith("CREATE ROLE")){
      await options.beforeCreate?.();created.add('trial_owner');
      if(options.lostAck)throw Error("private remote SQL must never escape");
      return{rows:[]};
    }
    if(text.includes("rolcanlogin"))return{rows:created.has(String(values?.[0]))?[{rolcanlogin:false,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolreplication:false,rolbypassrls:false,rolinherit:false,rolconnlimit:-1,rolvaliduntil:null,rolconfig:null}]:[]};
    throw Error("fixture only implements catalog and first role");
  });
  vi.mocked(connectPermitDatabase).mockResolvedValue({client:{query} as never,close:async()=>undefined});
  return{query,sent,created};
}
describe("fixed trial bootstrap",()=>{
  it("denies a direct call without catalog authorization before connecting",async()=>{
    const f=await fixture();catalog();
    await expect(bootstrapTrialDatabase({...f,beforeFirstWrite:undefined})).rejects.toThrow("trial_catalog_capability_required");
    expect(connectPermitDatabase).not.toHaveBeenCalled();
  });
  it("accepts only a fixed catalog and fictional numeric case manifest",()=>{
    expect(()=>bootstrapManifestSchema.parse({schema:1,adminCatalog:"other",adminUser:"admin",cases:[]})).toThrow();
    expect(()=>bootstrapManifestSchema.parse({schema:1,adminCatalog:"postgres",adminUser:'admin; drop role x',cases:[{id:1,title:"FICTIONAL TRIAL SAMPLE 1"}]})).toThrow();
  });
  it("rejects a mismatched host, catalog, admin, role or sample before connecting",async()=>{
    const f=await fixture();catalog();
    await expect(bootstrapTrialDatabase({...f,credentials:{...f.credentials,adminUrl:f.credentials.adminUrl.replace("/postgres","/fictional_trial")}})).rejects.toThrow("binding_invalid");
    await expect(bootstrapTrialDatabase({...f,manifest:{...f.manifest,adminUser:f.policy.database.webUser}})).rejects.toThrow("binding_invalid");
    await expect(bootstrapTrialDatabase({...f,manifest:{...f.manifest,cases:[{id:2,title:"FICTIONAL TRIAL SAMPLE 2"}]}})).rejects.toThrow("binding_invalid");
    expect(connectPermitDatabase).not.toHaveBeenCalled();
  });
  it("refuses a preexisting role without an intent, and edits no shared ACL",async()=>{
    const f=await fixture(),db=catalog({occupied:true});
    await expect(bootstrapTrialDatabase(f)).rejects.toThrow("name_occupied");
    expect(db.sent.some(s=>/CREATE|REVOKE|GRANT|ALTER/.test(s))).toBe(false);
  });
  it("fails closed on PUBLIC business ACL without repairing the existing catalog",async()=>{
    const f=await fixture(),db=catalog({publicHazard:true});
    await expect(bootstrapTrialDatabase(f)).rejects.toThrow("shared_acl_hazard");
    expect(db.sent.some(s=>/CREATE|REVOKE|GRANT|ALTER/.test(s))).toBe(false);
  });
  it("fsyncs an unknown intent before DDL and never resends it after lost ACK, a new password or ticket",async()=>{
    const f=await fixture();let saved="";
    const db=catalog({lostAck:true,beforeCreate:async()=>{
      const files=(await readdir(f.recoveryDirectory)).filter(n=>n.endsWith(".jsonl"));expect(files).toHaveLength(1);
      saved=await readFile(join(f.recoveryDirectory,files[0]),"utf8");expect(saved).toContain('"status":"outcome_unknown"');
    }});
    await expect(bootstrapTrialDatabase(f)).rejects.toThrow("trial_bootstrap_failed_role-0");
    expect(saved).not.toContain(f.credentials.adminUrl);expect(saved).not.toContain("CREATE ROLE");
    for(const password of [f.credentials.migratorPassword,f.credentials.webPassword,f.credentials.workerPassword])expect(saved).not.toContain(password);
    await expect(bootstrapTrialDatabase({...f,credentials:{...f.credentials,migratorPassword:"different-fictional-only"}})).rejects.toThrow("reconciliation_required");
    expect(db.sent.filter(s=>s.startsWith("CREATE ROLE"))).toHaveLength(1);
    await expect(bootstrapTrialDatabase({...f,mode:"reconcile"})).rejects.toThrow("reconciliation_required"); // confirms owner, stops before unsent LOGIN
    expect(db.sent.filter(s=>s.startsWith("CREATE ROLE"))).toHaveLength(1);
  });
  it("expires the ten-minute DB window despite the longer operator ticket",async()=>{
    const f=await fixture();f.advance(595000);catalog();
    await expect(bootstrapTrialDatabase(f)).rejects.toThrow("window_expired");expect(connectPermitDatabase).not.toHaveBeenCalled();
  });
  it("rejects cancellation before any connection or DDL",async()=>{
    const f=await fixture();f.access.dispose();catalog();
    await expect(bootstrapTrialDatabase(f)).rejects.toThrow("access_expired");expect(connectPermitDatabase).not.toHaveBeenCalled();
  });
  it("serializes two stale-lock reconciliations and cannot steal the replacement live lock",async()=>{
    const f=await fixture(),d=f.policy.database,db=catalog();
    const binding=trialHash(JSON.stringify({schema:1,host:d.host,database:d.database,owner:d.ownerRole,migrator:d.migratorUser,web:d.webUser,worker:d.workerUser,
      adminCatalog:f.manifest.adminCatalog,adminUser:f.manifest.adminUser}));
    await writeFile(join(f.recoveryDirectory,`bootstrap-${binding}.lock`),JSON.stringify({schema:1,pid:2147483647,automaticResend:false}),{flag:"wx",mode:0o600});
    const probe=vi.spyOn(process,"kill").mockImplementation(()=>{throw Object.assign(Error("fixture_pid_absent"),{code:"ESRCH"});});
    try{
      const results=await Promise.allSettled([bootstrapTrialDatabase({...f,mode:"reconcile"}),bootstrapTrialDatabase({...f,mode:"reconcile"})]);
      const errors=results.map(r=>r.status==="rejected"?String(r.reason.message):"unexpected_success");
      expect(errors.sort()).toEqual(["trial_bootstrap_locked","trial_bootstrap_reconciliation_required"].sort());
      expect((await readdir(f.recoveryDirectory)).filter(n=>n.includes(".stale-"))).toHaveLength(1);
      expect(db.sent.some(s=>/CREATE|REVOKE|GRANT|ALTER/.test(s))).toBe(false);
    }finally{probe.mockRestore();}
  });
});
