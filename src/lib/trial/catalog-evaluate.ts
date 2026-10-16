import { TrialError, TRIAL_END } from "./policy";
import { CATALOG_PACK, CATALOG_QUERY_BYTES, CATALOG_SNAPSHOT_BYTES, catalogCanonical, catalogDigest } from "./catalog-queries";
import { builtinManifestSchema, catalogDbSchema, catalogPassSchema, catalogPlanSchema, parseCatalogSnapshot, type Acl, type BuiltinManifest, type CatalogData, type CatalogDataKey, type CatalogPass, type CatalogPlan, type CatalogSnapshot, type DbRow, type FrozenInventory, type MemberRow, type RoleRow, type TypeRow } from "./catalog-schema";

function deny():never{throw new TrialError("trial_catalog_unconfirmed");}
function must(value:unknown):asserts value{if(!value)deny();}
const keys:readonly CatalogDataKey[]=CATALOG_PACK;
const cmp=(a:string,b:string)=>a<b?-1:a>b?1:0;
function normalRow(value:unknown):unknown{
  if(Array.isArray(value))return value.map(normalRow);
  if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k.endsWith("acl")&&Array.isArray(v)?ordered(v):normalRow(v)]));
  return value;
}
function ordered(rows:readonly unknown[]):unknown[]{return rows.map(normalRow).sort((a,b)=>cmp(catalogCanonical(a),catalogCanonical(b)));}
const same=(a:unknown,b:unknown)=>catalogCanonical(normalRow(a))===catalogCanonical(normalRow(b));
const sameRows=(a:readonly unknown[],b:readonly unknown[])=>same(ordered(a),ordered(b));
function normalizedData(s:CatalogData){return Object.fromEntries(keys.map(k=>[k,ordered(s[k])]));}
function normalizedSnapshot(s:CatalogSnapshot){return {schema:s.schema,database:normalRow(s.database),identity:s.identity,...normalizedData(s)};}
function index<T>(rows:readonly T[],key:(r:T)=>string):Map<string,T>{const m=new Map<string,T>();for(const r of rows){const k=key(r);must(!m.has(k));m.set(k,r);}return m;}
function byOid<T extends {oid:number}>(rows:readonly T[]){return index(rows,r=>String(r.oid));}
const ref=(m:Map<string,unknown>,id:number)=>must(m.has(String(id)));
const TABLE=new Set(["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER"]);
const SEQUENCE=new Set(["SELECT","UPDATE","USAGE"]);
const COLUMN=new Set(["SELECT","INSERT","UPDATE","REFERENCES"]);
const USAGE=new Set(["USAGE"]);
const SCHEMA=new Set(["USAGE","CREATE"]);
const EXECUTE=new Set(["EXECUTE"]);
const DATABASE=new Set(["CREATE","CONNECT","TEMPORARY"]);
const LARGE=new Set(["SELECT","UPDATE"]);
const PARAMETER=new Set(["SET","ALTER SYSTEM"]);
const CREATE=new Set(["CREATE"]);
const NONE=new Set<string>();
function checkAcl(acl:Acl,roles:Map<string,RoleRow>,allowed:Set<string>){
  index(acl,a=>catalogCanonical(a));
  for(const[g,r,p,grantable]of acl){ref(roles,g);if(r!==0)ref(roles,r);must(allowed.has(p)&&!(r===0&&grantable));}
}
function validateData(s:CatalogData){
  const roles=byOid(s.roles);index(s.roles,r=>r.rolname);
  const ns=byOid(s.namespaces);index(s.namespaces,r=>r.nspname);
  const rel=byOid(s.relations);index(s.relations,r=>`${r.relnamespace}/${r.relname}`);
  const proc=byOid(s.routines);index(s.routines,r=>`${r.pronamespace}/${r.proname}/${r.proargtypes}`);
  const types=byOid(s.types);index(s.types,r=>`${r.typnamespace}/${r.typname}`);
  const ext=byOid(s.extensions);index(s.extensions,r=>r.extname);
  const fdw=byOid(s.foreignWrappers);byOid(s.foreignServers);byOid(s.largeObjects);byOid(s.defaults);byOid(s.parameters);index(s.parameters,r=>r.parname);
  index(s.members,r=>`${r.roleid}/${r.member}/${r.grantor}`);
  for(const r of s.members){ref(roles,r.roleid);ref(roles,r.member);ref(roles,r.grantor);must(r.member!==r.roleid);}
  index(s.settings,r=>`${r.setdatabase}/${r.setrole}`);for(const r of s.settings)if(r.setrole)ref(roles,r.setrole);
  for(const r of s.namespaces){ref(roles,r.nspowner);checkAcl(r.nspacl,roles,SCHEMA);}
  for(const r of s.relations){ref(ns,r.relnamespace);ref(roles,r.relowner);checkAcl(r.relacl,roles,r.relkind==="S"?SEQUENCE:TABLE);}
  index(s.columns,r=>`${r.attrelid}/${r.attnum}`);for(const r of s.columns){ref(rel,r.attrelid);checkAcl(r.attacl,roles,COLUMN);}
  for(const r of s.routines){ref(ns,r.pronamespace);ref(roles,r.proowner);ref(types,r.prorettype);for(const n of r.proargtypes?r.proargtypes.split(" "):[])ref(types,Number(n));checkAcl(r.proacl,roles,EXECUTE);}
  index(s.defaults,r=>`${r.defaclrole}/${r.defaclnamespace}/${r.defaclobjtype}`);
  for(const r of s.defaults){ref(roles,r.defaclrole);if(r.defaclnamespace)ref(ns,r.defaclnamespace);checkAcl(r.defaclacl,roles,r.defaclobjtype==="r"?TABLE:r.defaclobjtype==="S"?SEQUENCE:r.defaclobjtype==="f"?EXECUTE:r.defaclobjtype==="n"?SCHEMA:USAGE);}
  for(const r of s.largeObjects){ref(roles,r.lomowner);checkAcl(r.lomacl,roles,LARGE);}
  for(const r of s.types){ref(ns,r.typnamespace);ref(roles,r.typowner);for(const n of [r.typelem,r.typarray,r.typbasetype])if(n)ref(types,n);for(const n of [r.typinput,r.typoutput,r.typreceive,r.typsend,r.typmodin,r.typmodout,r.typanalyze,r.typsubscript])if(n)ref(proc,n);checkAcl(r.typacl,roles,USAGE);}
  for(const r of s.foreignWrappers){ref(roles,r.fdwowner);for(const n of [r.fdwhandler,r.fdwvalidator])if(n)ref(proc,n);checkAcl(r.fdwacl,roles,USAGE);}
  for(const r of s.foreignServers){ref(roles,r.srvowner);ref(fdw,r.srvfdw);checkAcl(r.srvacl,roles,USAGE);}
  for(const r of s.extensions){ref(roles,r.extowner);ref(ns,r.extnamespace);}
  index(s.extensionMembers,r=>`${r.classid}/${r.objid}/${r.objsubid}/${r.refclassid}/${r.refobjid}/${r.refobjsubid}/${r.deptype}`);
  for(const r of s.extensionMembers){ref(rel,r.classid);ref(rel,r.refclassid);ref(ext,r.refobjid);must(rel.get(String(r.refclassid))?.relname==="pg_extension");}
  for(const r of s.parameters)checkAcl(r.paracl,roles,PARAMETER);
}
function validatedBuiltin(b:BuiltinManifest,p:CatalogPlan):BuiltinManifest{
  const v=builtinManifestSchema.parse(b);must(catalogDigest(v)===p.builtinManifestSha256);validateData(v.catalogs);
  must(v.catalogs.roles.some(r=>r.oid===v.bootstrapSuperuserOid&&r.rolsuper));return v;
}
function nativeSubset<T extends {oid:number}>(live:readonly T[],fixed:readonly T[]):Set<number>{
  const m=byOid(live);byOid(fixed);const ids=new Set<number>();
  for(const f of fixed){const r=m.get(String(f.oid));must(r&&same(r,f));ids.add(f.oid);}return ids;
}
function exactNative(live:readonly unknown[],fixed:readonly unknown[]){must(sameRows(live,fixed));}
function nativeNamespaces(live:CatalogData["namespaces"],fixed:CatalogData["namespaces"]){
  const m=byOid(live);byOid(fixed);
  for(const f of fixed){const r=m.get(String(f.oid));must(r);
    // Public is an application namespace: existing unrelated roles may have
    // grants. Subject hazards are checked below and every ACL remains hashed.
    if(f.nspname==="public")must(r.oid===f.oid&&r.nspname===f.nspname&&r.nspowner===f.nspowner);
    else must(same(r,f));
  }
}
const touches=(acl:Acl,subjects:Set<number>,privs?:Set<string>)=>acl.some(([,r,p])=>subjects.has(r)&&(!privs||privs.has(p)));
function fourRoles(s:CatalogData,p:CatalogPlan,useUntil:string):RoleRow[]{
  const m=index(s.roles,r=>r.rolname),names=[p.roles.owner,p.roles.migrator,p.roles.web,p.roles.worker];
  const found=names.map(n=>m.get(n));must(found.every(r=>r!==undefined));const result=found as RoleRow[];
  const limits=[-1,1,3,1],until=[null,useUntil,TRIAL_END,TRIAL_END];must(Number.isFinite(Date.parse(useUntil)));
  result.forEach((r,i)=>{must(!r.rolsuper&&!r.rolcreatedb&&!r.rolcreaterole&&!r.rolreplication&&!r.rolbypassrls&&!r.rolinherit&&!r.has_settings&&r.rolcanlogin===(i!==0)&&r.rolconnlimit===limits[i]);const expected=until[i];if(expected===null)must(r.rolvaliduntil===null);else must(r.rolvaliduntil!==null&&Number.isFinite(Date.parse(r.rolvaliduntil))&&Date.parse(r.rolvaliduntil)===Date.parse(expected));});
  must(new Set(result.map(r=>r.oid)).size===4);return result;
}
function subjectsFor(s:CatalogData,p:CatalogPlan,stage:"before"|"after",context?:{useUntil:string}):Set<number>{
  if(stage==="before"){const wanted=new Set(Object.values(p.roles));must(!s.roles.some(r=>wanted.has(r.rolname)));return new Set([0]);}
  must(context);const four=fourRoles(s,p,context.useUntil),ids=new Set(four.map(r=>r.oid));
  const outgoing=s.members.filter(m=>ids.has(m.member));must(outgoing.length===1);
  const m=outgoing[0];must(m.member===four[1].oid&&m.roleid===four[0].oid&&!m.admin_option&&!m.inherit_option&&m.set_option);
  return new Set([0,...ids]);
}
const callbacks=["typinput","typoutput","typreceive","typsend","typmodin","typmodout","typanalyze","typsubscript"] as const;
const sameCallbacks=(a:TypeRow,b:TypeRow)=>callbacks.every(k=>a[k]===b[k]);
function businessTypes(s:CatalogData,b:CatalogData,native:Set<number>,nativeRelations:Set<number>,subjects:Set<number>){
  const types=byOid(s.types),relations=byOid(s.relations);
  const prototype=b.types.find(t=>t.typtype==="c"&&t.typrelid!==0&&t.typarray!==0);must(prototype);
  const array=b.types.find(t=>t.oid===prototype.typarray);must(array&&array.typtype==="b"&&array.typelem===prototype.oid);
  const allowed=new Set(native),extra=s.types.filter(t=>!native.has(t.oid));
  for(const t of extra){must(!subjects.has(t.typowner));if(t.typtype!=="c")continue;
    const r=relations.get(String(t.typrelid));must(r&&!nativeRelations.has(r.oid)&&["r","p","v","m","f"].includes(r.relkind));
    must(t.typnamespace===r.relnamespace&&t.typname===r.relname&&t.typowner===r.relowner&&t.typelem===0&&t.typbasetype===0&&t.typarray!==0&&sameCallbacks(t,prototype));allowed.add(t.oid);
  }
  let progress=true;while(progress){progress=false;for(const t of extra){
    if(allowed.has(t.oid)||t.typtype!=="b"||t.typrelid!==0||t.typbasetype!==0||t.typarray!==0||!allowed.has(t.typelem))continue;
    const e=types.get(String(t.typelem));must(e&&e.typarray===t.oid&&e.typowner===t.typowner&&e.typnamespace===t.typnamespace&&sameCallbacks(t,array));allowed.add(t.oid);progress=true;
  }}
  must(allowed.size===s.types.length);for(const t of extra)if(t.typtype==="c"){const a=types.get(String(t.typarray));must(a&&allowed.has(a.oid)&&a.typelem===t.oid);}
}
function createdMemberships(s:CatalogData,b:BuiltinManifest,p:CatalogPlan,useUntil:string):Set<number>{
  const four=fourRoles(s,p,useUntil),ids=new Set(four.map(r=>r.oid));
  const creator=s.roles.find(r=>r.rolname===p.adminUser);must(creator);
  const normalGrantor=creator.rolsuper?b.bootstrapSuperuserOid:creator.oid;
  const expected:MemberRow[]=[{roleid:four[0].oid,member:four[1].oid,grantor:normalGrantor,admin_option:false,inherit_option:false,set_option:true}];
  if(!creator.rolsuper){must(creator.rolcreaterole);for(const r of four)expected.push({roleid:r.oid,member:creator.oid,grantor:b.bootstrapSuperuserOid,admin_option:true,inherit_option:false,set_option:false});}
  const touched=s.members.filter(m=>ids.has(m.roleid)||ids.has(m.member)||ids.has(m.grantor));
  must(sameRows(touched,expected));return ids;
}
function freezeValue<T>(value:T):T{if(value&&typeof value==="object"&&!Object.isFrozen(value)){for(const v of Object.values(value))freezeValue(v);Object.freeze(value);}return value;}
export function freezeCatalogInventory(rows:unknown,plan:CatalogPlan):FrozenInventory{
  try{
    const p=catalogPlanSchema.parse(plan);must(Buffer.byteLength(catalogCanonical(rows),"utf8")<=CATALOG_QUERY_BYTES);
    const all=catalogDbSchema.array().max(p.limits.rowsPerQuery).parse(rows);byOid(all);index(all,d=>d.datname);
    must(all.length>0&&!all.some(d=>d.datname===p.targetDatabase));
    const excluded=index(p.excludedDatabases,e=>e.name);
    for(const e of p.excludedDatabases){const d=all.find(x=>x.datname===e.name);must(d&&d.datistemplate===e.template&&d.datallowconn===e.allowConnect);}
    const audited=all.filter(d=>!excluded.has(d.datname));
    must(audited.length>=1&&audited.length<=p.maximumAuditConnections&&audited.some(d=>d.datname==="postgres"));
    for(const d of audited)must(d.datallowconn);
    all.sort((a,b)=>a.oid-b.oid);audited.sort((a,b)=>a.oid-b.oid);
    return freezeValue({schema:1 as const,all,audited,digest:catalogDigest({all:ordered(all),audited:ordered(audited)})});
  }catch{return deny();}
}
export type CatalogEvaluation={status:"verified";fingerprint:string;counts:Record<CatalogDataKey,number>;findingsDigest:string};
export function evaluateCatalogSnapshot(snapshot:CatalogSnapshot,builtins:BuiltinManifest,plan:CatalogPlan,stage:"before"|"after",context?:{useUntil:string}):CatalogEvaluation{
  try{
    must(stage==="before"||stage==="after");const p=catalogPlanSchema.parse(plan),s=parseCatalogSnapshot(snapshot),b=validatedBuiltin(builtins,p),fixed=b.catalogs;
    validateData(s);must(s.identity.database===s.database.datname&&s.identity.username===p.adminUser);
    const roleMap=byOid(s.roles);ref(roleMap,s.database.datdba);checkAcl(s.database.datacl,roleMap,DATABASE);must(s.roles.some(r=>r.rolname===p.adminUser));
    const subjects=subjectsFor(s,p,stage,context);if(stage==="after"){must(context);createdMemberships(s,b,p,context.useUntil);}
    must(!subjects.has(s.database.datdba)&&!touches(s.database.datacl,subjects,CREATE));
    nativeNamespaces(s.namespaces,fixed.namespaces);
    const nativeRelations=nativeSubset(s.relations,fixed.relations);
    nativeSubset(s.routines,fixed.routines);must(s.routines.length===fixed.routines.length);
    const nativeTypes=nativeSubset(s.types,fixed.types);
    exactNative(s.extensions,fixed.extensions);exactNative(s.extensionMembers,fixed.extensionMembers);
    exactNative(s.foreignWrappers,fixed.foreignWrappers);exactNative(s.foreignServers,fixed.foreignServers);
    for(const n of s.namespaces)must(!subjects.has(n.nspowner)&&!touches(n.nspacl,subjects,CREATE));
    for(const r of s.relations){must(!subjects.has(r.relowner));if(!nativeRelations.has(r.oid))must(!touches(r.relacl,subjects));}
    for(const c of s.columns)if(!nativeRelations.has(c.attrelid))must(!touches(c.attacl,subjects));
    exactNative(s.columns.filter(c=>nativeRelations.has(c.attrelid)),fixed.columns);
    for(const l of s.largeObjects)must(!subjects.has(l.lomowner)&&!touches(l.lomacl,subjects));
    for(const a of s.parameters)must(!touches(a.paracl,subjects));
    for(const r of s.settings)if(r.has_settings&&r.setrole!==0&&subjects.has(r.setrole))deny();
    businessTypes(s,fixed,nativeTypes,nativeRelations,subjects);
    for(const d of s.defaults){must(!subjects.has(d.defaclrole));const dangerous=d.defaclobjtype==="T"?NONE:d.defaclobjtype==="n"?CREATE:undefined;must(!touches(d.defaclacl,subjects,dangerous));}
    const counts=Object.fromEntries(keys.map(k=>[k,s[k].length])) as Record<CatalogDataKey,number>;
    return {status:"verified",fingerprint:catalogDigest(normalizedSnapshot(s)),counts,findingsDigest:catalogDigest([])};
  }catch{return deny();}
}
function checkPassSnapshots(pass:CatalogPass,expected:readonly DbRow[],b:BuiltinManifest,p:CatalogPlan,stage:"before"|"after",useUntil:string){
  const inventory=byOid(pass.inventory);index(pass.inventory,d=>d.datname);
  const snapshots=index(pass.snapshots,s=>String(s.database.oid));must(snapshots.size===expected.length);
  const shared:readonly CatalogDataKey[]=["roles","members","settings","parameters"];
  const first=pass.snapshots[0];must(first);
  for(const row of expected){const s=snapshots.get(String(row.oid));must(s&&same(s.database,row)&&same(inventory.get(String(row.oid)),row));
    evaluateCatalogSnapshot(s,b,p,stage,{useUntil});
    const roles=byOid(s.roles);
    for(const d of pass.inventory){ref(roles,d.datdba);checkAcl(d.datacl,roles,DATABASE);}
    for(const r of s.settings)if(r.setdatabase)ref(inventory,r.setdatabase);
    for(const key of shared)must(sameRows(s[key],first[key]));
  }
}
function checkNewDatabase(row:DbRow,p:CatalogPlan,four:RoleRow[]){
  must(row.datname===p.targetDatabase&&row.datdba===four[0].oid&&!row.datistemplate&&row.datallowconn);
  const owner=four[0].oid;
  const expected:Acl=[...["CREATE","CONNECT","TEMPORARY"].map(priv=>[owner,owner,priv,false] as Acl[number]),...four.slice(1).map(r=>[owner,r.oid,"CONNECT",false] as Acl[number])];
  must(sameRows(row.datacl,expected));
}
function passContents(inventory:readonly DbRow[],snapshots:readonly CatalogSnapshot[]){return {inventory:ordered(inventory),snapshots:ordered(snapshots.map(normalizedSnapshot))};}
export function verifyInitialCatalogPass(value:CatalogPass,b: BuiltinManifest,p:CatalogPlan,useUntil:string){
  const initial=catalogPassSchema.parse(value);must(initial.stage===1);
  const frozen=freezeCatalogInventory(initial.inventory,p);checkPassSnapshots(initial,frozen.audited,b,p,"before",useUntil);
  return catalogDigest(passContents(initial.inventory,initial.snapshots));
}
export function compareCatalogPasses(initialInput:CatalogPass,nextInput:CatalogPass,builtins:BuiltinManifest,plan:CatalogPlan,useUntil:string):{existingFingerprint:string;passFingerprint:string}{
  try{
    const p=catalogPlanSchema.parse(plan),b=validatedBuiltin(builtins,p);
    must(Buffer.byteLength(catalogCanonical(initialInput),"utf8")<=6*CATALOG_SNAPSHOT_BYTES+CATALOG_QUERY_BYTES);
    must(Buffer.byteLength(catalogCanonical(nextInput),"utf8")<=6*CATALOG_SNAPSHOT_BYTES+CATALOG_QUERY_BYTES);
    const initial=catalogPassSchema.parse(initialInput),next=catalogPassSchema.parse(nextInput);
    must(initial.stage===1&&(next.stage===2||next.stage===3));must(Number.isFinite(Date.parse(useUntil)));
    const frozen=freezeCatalogInventory(initial.inventory,p);
    checkPassSnapshots(initial,frozen.audited,b,p,"before",useUntil);
    const initialContent=passContents(initial.inventory,initial.snapshots);
    const existingFingerprint=catalogDigest(initialContent);
    if(next.stage===2){
      must(sameRows(initial.inventory,next.inventory));checkPassSnapshots(next,frozen.audited,b,p,"before",useUntil);
      must(catalogDigest(passContents(next.inventory,next.snapshots))===existingFingerprint);
    }else{
      const added=next.inventory.filter(d=>d.datname===p.targetDatabase);must(added.length===1);
      const retained=next.inventory.filter(d=>d.datname!==p.targetDatabase);must(sameRows(initial.inventory,retained));
      checkPassSnapshots(next,frozen.audited,b,p,"after",useUntil);
      const first=next.snapshots[0];must(first);const four=fourRoles(first,p,useUntil);checkNewDatabase(added[0],p,four);
      const ids=new Set(four.map(r=>r.oid));
      const projected=next.snapshots.map(s=>({...s,roles:s.roles.filter(r=>!ids.has(r.oid)),members:s.members.filter(m=>!ids.has(m.roleid)&&!ids.has(m.member)&&!ids.has(m.grantor))}));
      must(catalogDigest(passContents(retained,projected))===existingFingerprint);
    }
    return {existingFingerprint,passFingerprint:catalogDigest({stage:next.stage,...passContents(next.inventory,next.snapshots)})};
  }catch{return deny();}
}
