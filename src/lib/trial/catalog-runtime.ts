import { open, lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { CatalogAccess } from "./catalog-access";
import { connectPermitDatabase } from "./database-client";
import { CATALOG_PACK, CATALOG_QUERIES, catalogCanonical, catalogDigest, type CatalogQueryId } from "./catalog-queries";
import { builtinManifestSchema, catalogDbSchema, catalogIdentitySchema, catalogPlanSchema, parseCatalogRows, parseCatalogSnapshot,
  type BuiltinManifest, type CatalogData, type CatalogPass, type CatalogPlan, type CatalogSnapshot, type FrozenInventory } from "./catalog-schema";
import { compareCatalogPasses, evaluateCatalogSnapshot, freezeCatalogInventory, verifyInitialCatalogPass } from "./catalog-evaluate";
import { TrialError, type TrialPolicy } from "./policy";
import type { OperatorTicket } from "./operator-access";

type Window = NonNullable<OperatorTicket["databaseWindow"]>;
type Connection = Awaited<ReturnType<typeof connectPermitDatabase>>;
const fail = () => new TrialError("trial_catalog_unconfirmed");
const sha = (bytes: string) => createHash("sha256").update(bytes,"utf8").digest("hex");
declare const capabilityBrand: unique symbol;
export type CatalogBootstrapCapability = { readonly [capabilityBrand]: true };
export type BootstrapAuthority = Readonly<{mode:"native-superuser"|"temporary-owner-set";adminUser:string;adminOid:number;bootstrapSuperuserOid:number;authoritySha256?:string}>;
const capabilities = new WeakMap<object,{ audit: CatalogAudit; binding: string; authority:BootstrapAuthority }>();
const ddlBinding = (p:TrialPolicy,w:Window) => catalogDigest({codeSha:p.codeSha,database:p.database,window:w,catalogPlanDigest:p.localOperator?.catalogPlanDigest});
function deepFreeze<T>(value:T):T{
  if(value&&typeof value==="object"){for(const item of Object.values(value))deepFreeze(item);Object.freeze(value);}return value;
}

/** No serializable verified flag authorizes DDL. Only this process's second
 * successful catalog pass can issue the one-use capability. */
export function consumeCatalogBootstrapCapability(value: unknown, p:TrialPolicy,w:Window) {
  if (!value || typeof value!=="object") throw fail();
  const proof=capabilities.get(value); capabilities.delete(value);
  if(!proof || proof.binding!==ddlBinding(p,w))throw fail();
  proof.audit.consumeCapability();
  return proof.authority;
}

export class CatalogAudit {
  readonly plan:CatalogPlan;
  readonly builtins:BuiltinManifest;
  private readonly connections = new Map<string,Connection>();
  private inventory?:FrozenInventory;
  private initial?:CatalogPass;
  private stage=0;
  private busy=false;
  private failed=false;
  private issued=false;
  private consumed=false;
  private attempts=0;
  private readonly receipts:string[]=[];
  constructor(plan:unknown,builtins:unknown,private readonly access:CatalogAccess,private readonly adminUrl:string,
    private readonly directory:string,private readonly credential:{getToken():Promise<{token:string}>},
    private readonly factory:typeof connectPermitDatabase=connectPermitDatabase) {
    this.plan=deepFreeze(catalogPlanSchema.parse(plan));this.builtins=deepFreeze(builtinManifestSchema.parse(builtins));
    const p=access.policy,d=p.database,expected={owner:d.ownerRole,migrator:d.migratorUser,web:d.webUser,worker:d.workerUser};
    const url=new URL(adminUrl);
    if(p.localOperator?.catalogPlanDigest!==catalogDigest(this.plan)||catalogDigest(this.builtins)!==this.plan.builtinManifestSha256 || this.plan.server!==d.host ||
      this.plan.targetDatabase!==d.database || catalogDigest(expected)!==catalogDigest(this.plan.roles) ||
      url.protocol!=="postgresql:"||url.hostname!==d.host||Number(url.port||5432)!==5432||url.search||url.hash||
      !url.password||decodeURIComponent(url.username)!==this.plan.adminUser||decodeURIComponent(url.pathname.slice(1))!=="postgres"||
      !isAbsolute(directory)||sha(resolve(directory))!==p.localOperator?.recoveryDirectoryDigest)throw fail();
  }
  private now(){return Date.parse(this.access.ticket.endsAt)-this.access.check(0);}
  private check(){if(this.failed)throw fail();this.access.check(10000);}
  private async connect(database:string){
    this.check(); const old=this.connections.get(database);if(old)return old;
    if(this.stage!==0||this.attempts>=this.plan.maximumAuditConnections)throw fail();
    if(database!=="postgres"&&!this.inventory?.audited.some(d=>d.datname===database))throw fail();
    this.attempts++;const url=new URL(this.adminUrl);url.pathname="/"+encodeURIComponent(database);
    const connection=await this.factory({url:url.href,host:this.plan.server,database,user:this.plan.adminUser,catalogOnly:true},this.access,this.credential);
    if(this.failed||this.access.signal.aborted){await connection.close();throw fail();}
    this.connections.set(database,connection);return connection;
  }
  async runPass(pass:1|2|3){
    this.check();
    if(this.busy||pass!==this.stage+1 || (pass===3&&!this.consumed))throw fail();
    this.busy=true;
    const startedAt=new Date(this.now()).toISOString(),counts={databases:0,queries:0,rows:0,bytes:0};
    const snapshots:CatalogSnapshot[]=[], window=this.access.ticket.databaseWindow!;
    let inventory:FrozenInventory["all"]|undefined;
    const collect=async(database:string)=>{
      const connection=await this.connect(database);let dbBytes=0;
      const query=async(id:CatalogQueryId)=>{
        this.check();counts.queries++;
        const result=await connection.client.query(CATALOG_QUERIES[id]);
        this.check();
        if(!result||!Array.isArray(result.rows)||result.rows.length>this.plan.limits.rowsPerQuery)throw fail();
        if(id!=="begin"&&id!=="commit"){
          const bytes=Buffer.byteLength(catalogCanonical(result.rows),"utf8");
          dbBytes+=bytes;counts.bytes+=bytes;counts.rows+=result.rows.length;
          if(bytes>this.plan.limits.bytesPerQuery||dbBytes>this.plan.limits.bytesPerSnapshot)throw fail();
        }else if(result.rows.length)throw fail();
        return result.rows;
      };
      await query("begin");
      const identityRows=await query("identity");if(identityRows.length!==1)throw fail();
      const identity=catalogIdentitySchema.parse(identityRows[0]);
      if(identity.database!==database||identity.username!==this.plan.adminUser)throw fail();
      const rows=catalogDbSchema.array().max(this.plan.limits.rowsPerQuery).parse(await query("inventory"));
      if(!inventory)inventory=rows;
      else if(catalogDigest(inventory)!==catalogDigest(rows))throw fail();
      if(!this.inventory)this.inventory=freezeCatalogInventory(rows,this.plan);
      const db=rows.find(r=>r.datname===database);if(!db)throw fail();
      const data:Partial<CatalogData>={};
      for(const id of CATALOG_PACK)Object.assign(data,{[id]:parseCatalogRows(id,await query(id))});
      const snapshot=parseCatalogSnapshot({schema:1,database:db,identity,...data});
      evaluateCatalogSnapshot(snapshot,this.builtins,this.plan,pass===3?"after":"before",{useUntil:window.useUntil});
      await query("commit");counts.databases++;snapshots.push(snapshot);
    };
    try{
      await collect("postgres");
      for(const database of this.inventory!.audited)if(database.datname!=="postgres")await collect(database.datname);
      const current:CatalogPass={schema:1,stage:pass,inventory:inventory!,snapshots};
      let existingFingerprint:string;
      if(pass===1){existingFingerprint=verifyInitialCatalogPass(current,this.builtins,this.plan,window.useUntil);this.initial=current;}
      else existingFingerprint=compareCatalogPasses(this.initial!,current,this.builtins,this.plan,window.useUntil).existingFingerprint;
      const receipt={schema:1,pass,codeSha:this.access.policy.codeSha,auditPlanDigest:catalogDigest(this.plan),
        querySetDigest:this.plan.querySetSha256,builtinManifestSha256:this.plan.builtinManifestSha256,
        databaseWindowDigest:catalogDigest(window),lifecycleId:window.lifecycleId,guardianNonce:window.guardianNonce,
        targetInventoryDigest:this.inventory!.digest,catalogDigest:existingFingerprint,startedAt,
        checkedAt:new Date(this.now()).toISOString(),auditConnectionAttempts:this.attempts,counts,status:"verified",automaticResend:false};
      const stat=await lstat(this.directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw fail();
      const serialized=catalogCanonical(receipt)+"\n";
      const file=await open(join(this.directory,`trial-catalog-pass-${pass}.json`),"wx",0o600);
      try{await file.writeFile(serialized);await file.sync();}finally{await file.close();}
      this.check();this.stage=pass;const digest=sha(serialized);this.receipts.push(digest);
      return{type:"catalog_pass" as const,schema:1 as const,pass,sha256:digest};
    }catch{this.failed=true;await this.close();throw fail();}
    finally{this.busy=false;}
  }
  issueBootstrapCapability():CatalogBootstrapCapability{
    this.check();if(this.stage!==2||this.issued)throw fail();
    const admins=this.initial!.snapshots[0].roles.filter(r=>r.rolname===this.plan.adminUser);
    if(admins.length!==1)throw fail();const admin=admins[0];
    if(!admin.rolsuper&&(!admin.rolcreatedb||!admin.rolcreaterole||!this.plan.bootstrapOwnerSet))throw fail();
    const authority:BootstrapAuthority=Object.freeze({mode:admin.rolsuper?"native-superuser":"temporary-owner-set",
      adminUser:admin.rolname,adminOid:admin.oid,bootstrapSuperuserOid:this.builtins.bootstrapSuperuserOid,
      ...(!admin.rolsuper?{authoritySha256:this.plan.bootstrapOwnerSet!.authoritySha256}:{})});
    this.issued=true;
    const token=Object.freeze({}) as CatalogBootstrapCapability;
    capabilities.set(token,{audit:this,binding:ddlBinding(this.access.policy,this.access.ticket.databaseWindow!),authority});return token;
  }
  consumeCapability(){this.check();if(this.stage!==2||!this.issued||this.consumed)throw fail();this.consumed=true;}
  result(){
    this.check();if(this.stage!==3||this.receipts.length!==3)throw fail();
    return{schema:1,pass1Sha256:this.receipts[0],pass2Sha256:this.receipts[1],pass3Sha256:this.receipts[2],auditPlanDigest:catalogDigest(this.plan),auditConnectionAttempts:this.attempts};
  }
  async close(){this.failed=true;await Promise.allSettled([...this.connections.values()].map(c=>c.close()));this.connections.clear();}
}
