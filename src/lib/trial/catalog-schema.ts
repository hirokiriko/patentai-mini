import { z } from "zod";
import { TrialError } from "./policy";
import { CATALOG_ROW_LIMIT, CATALOG_QUERY_BYTES, CATALOG_SNAPSHOT_BYTES, CATALOG_QUERY_SET_SHA256, catalogCanonical } from "./catalog-queries";

const oid=z.number().int().min(0).max(4294967295);
const objectOid=oid.refine(n=>n>0);
const name=z.string().min(1).refine(s=>Buffer.byteLength(s,"utf8")<=63&&!/[\x00-\x1f\x7f]/.test(s));
const dedicated=z.string().regex(/^[a-z][a-z0-9_]{1,62}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
export const bootstrapOwnerSetSchema=z.object({schema:z.literal(1),kind:z.literal("temporary-owner-set-v1"),authoritySha256:sha}).strict();
export const privilegeSchema=z.enum(["SELECT","INSERT","UPDATE","DELETE","TRUNCATE","REFERENCES","TRIGGER","USAGE","CREATE","CONNECT","TEMPORARY","EXECUTE","SET","ALTER SYSTEM"]);
export const aclSchema=z.array(z.tuple([objectOid,oid,privilegeSchema,z.boolean()])).max(4096);
export type Acl=z.infer<typeof aclSchema>;
export const catalogDbSchema=z.object({oid:objectOid,datname:name,datdba:objectOid,datistemplate:z.boolean(),datallowconn:z.boolean(),datacl:aclSchema}).strict();
export const roleSchema=z.object({oid:objectOid,rolname:name,rolsuper:z.boolean(),rolinherit:z.boolean(),rolcreaterole:z.boolean(),rolcreatedb:z.boolean(),rolcanlogin:z.boolean(),rolreplication:z.boolean(),rolbypassrls:z.boolean(),rolconnlimit:z.number().int().min(-1),rolvaliduntil:z.string().max(128).nullable(),has_settings:z.boolean()}).strict();
export const memberSchema=z.object({roleid:objectOid,member:objectOid,grantor:objectOid,admin_option:z.boolean(),inherit_option:z.boolean(),set_option:z.boolean()}).strict();
export const namespaceSchema=z.object({oid:objectOid,nspname:name,nspowner:objectOid,nspacl:aclSchema}).strict();
export const relationSchema=z.object({oid:objectOid,relnamespace:objectOid,relname:name,relowner:objectOid,relkind:z.enum(["r","p","v","m","f","S"]),relacl:aclSchema}).strict();
export const columnSchema=z.object({attrelid:objectOid,attnum:z.number().int().min(-32768).max(32767).refine(n=>n!==0),attisdropped:z.boolean(),attacl:aclSchema}).strict();
export const routineSchema=z.object({oid:objectOid,pronamespace:objectOid,proname:name,proowner:objectOid,prokind:z.enum(["f","p","a","w"]),prosecdef:z.boolean(),prolang:objectOid,proargtypes:z.string().max(2048).regex(/^(?:[0-9]+(?: [0-9]+)*)?$/),prorettype:objectOid,proacl:aclSchema}).strict();
export const defaultSchema=z.object({oid:objectOid,defaclrole:objectOid,defaclnamespace:oid,defaclobjtype:z.enum(["r","S","f","T","n"]),defaclacl:aclSchema}).strict();
export const largeObjectSchema=z.object({oid:objectOid,lomowner:objectOid,lomacl:aclSchema}).strict();
export const typeSchema=z.object({oid:objectOid,typnamespace:objectOid,typname:name,typowner:objectOid,typtype:z.enum(["b","c","d","e","m","p","r"]),typrelid:oid,typelem:oid,typarray:oid,typbasetype:oid,typinput:oid,typoutput:oid,typreceive:oid,typsend:oid,typmodin:oid,typmodout:oid,typanalyze:oid,typsubscript:oid,typacl:aclSchema}).strict();
const foreignServerSchema=z.object({oid:objectOid,srvowner:objectOid,srvfdw:objectOid,srvacl:aclSchema}).strict();
const foreignWrapperSchema=z.object({oid:objectOid,fdwowner:objectOid,fdwhandler:oid,fdwvalidator:oid,fdwacl:aclSchema}).strict();
const extensionSchema=z.object({oid:objectOid,extname:name,extowner:objectOid,extnamespace:objectOid,extversion:z.string().min(1).max(128)}).strict();
const extensionMemberSchema=z.object({classid:objectOid,objid:objectOid,objsubid:z.number().int().min(0),refclassid:objectOid,refobjid:objectOid,refobjsubid:z.number().int().min(0),deptype:z.literal("e")}).strict();
const parameterSchema=z.object({oid:objectOid,parname:name,paracl:aclSchema}).strict();
const settingSchema=z.object({setdatabase:oid,setrole:oid,has_settings:z.boolean()}).strict();
export const CATALOG_ROW_SCHEMAS={roles:roleSchema,members:memberSchema,settings:settingSchema,namespaces:namespaceSchema,relations:relationSchema,columns:columnSchema,routines:routineSchema,defaults:defaultSchema,largeObjects:largeObjectSchema,types:typeSchema,foreignServers:foreignServerSchema,foreignWrappers:foreignWrapperSchema,extensions:extensionSchema,extensionMembers:extensionMemberSchema,parameters:parameterSchema} as const;
const rows=<T extends z.ZodType>(schema:T)=>z.array(schema).max(CATALOG_ROW_LIMIT);
export const catalogDataSchema=z.object({roles:rows(roleSchema),members:rows(memberSchema),settings:rows(settingSchema),namespaces:rows(namespaceSchema),relations:rows(relationSchema),columns:rows(columnSchema),routines:rows(routineSchema),defaults:rows(defaultSchema),largeObjects:rows(largeObjectSchema),types:rows(typeSchema),foreignServers:rows(foreignServerSchema),foreignWrappers:rows(foreignWrapperSchema),extensions:rows(extensionSchema),extensionMembers:rows(extensionMemberSchema),parameters:rows(parameterSchema)}).strict();
export const catalogIdentitySchema=z.object({database:name,username:name,version:z.string().regex(/^16[0-9]{4}$/),isolation:z.literal("repeatable read"),readonly:z.literal("on"),search_path:z.literal("pg_catalog")}).strict();
export const catalogSnapshotSchema=catalogDataSchema.extend({schema:z.literal(1),database:catalogDbSchema,identity:catalogIdentitySchema}).strict();
export const catalogPlanSchema=z.object({schema:z.literal(1),server:z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}\.postgres\.database\.azure\.com$/),adminUser:dedicated,targetDatabase:dedicated,roles:z.object({owner:dedicated,migrator:dedicated,web:dedicated,worker:dedicated}).strict(),excludedDatabases:z.array(z.object({name,template:z.boolean(),allowConnect:z.literal(false)}).strict()).max(16),maximumAuditConnections:z.literal(6),builtinManifestSha256:sha,querySetSha256:z.literal(CATALOG_QUERY_SET_SHA256),bootstrapOwnerSet:bootstrapOwnerSetSchema.optional(),limits:z.object({rowsPerQuery:z.literal(CATALOG_ROW_LIMIT),bytesPerQuery:z.literal(CATALOG_QUERY_BYTES),bytesPerSnapshot:z.literal(CATALOG_SNAPSHOT_BYTES)}).strict()}).strict().refine(p=>new Set(Object.values(p.roles)).size===4&&!Object.values(p.roles).includes(p.adminUser)&&p.targetDatabase!=="postgres"&&new Set(p.excludedDatabases.map(x=>x.name)).size===p.excludedDatabases.length&&p.excludedDatabases.every(x=>x.name!=="postgres"&&x.name!==p.targetDatabase));
export const builtinManifestSchema=z.object({schema:z.literal(1),sourcePgVersion:z.string().regex(/^16[0-9]{4}$/),querySetSha256:z.literal(CATALOG_QUERY_SET_SHA256),bootstrapSuperuserOid:objectOid,catalogs:catalogDataSchema}).strict();
export const catalogPassSchema=z.object({schema:z.literal(1),stage:z.union([z.literal(1),z.literal(2),z.literal(3)]),inventory:rows(catalogDbSchema),snapshots:z.array(catalogSnapshotSchema).min(1).max(6)}).strict();
export type DbRow=z.infer<typeof catalogDbSchema>;
export type RoleRow=z.infer<typeof roleSchema>;
export type MemberRow=z.infer<typeof memberSchema>;
export type TypeRow=z.infer<typeof typeSchema>;
export type CatalogData=z.infer<typeof catalogDataSchema>;
export type CatalogDataKey=keyof CatalogData;
export type CatalogSnapshot=z.infer<typeof catalogSnapshotSchema>;
export type CatalogPlan=z.infer<typeof catalogPlanSchema>;
export type BuiltinManifest=z.infer<typeof builtinManifestSchema>;
export type CatalogPass=z.infer<typeof catalogPassSchema>;
export type FrozenInventory={schema:1;all:DbRow[];audited:DbRow[];digest:string};
export function parseCatalogRows<K extends CatalogDataKey>(key:K,value:unknown):CatalogData[K]{
  try{if(Buffer.byteLength(catalogCanonical(value),"utf8")>CATALOG_QUERY_BYTES)throw Error();return CATALOG_ROW_SCHEMAS[key].array().max(CATALOG_ROW_LIMIT).parse(value) as CatalogData[K];}
  catch{throw new TrialError("trial_catalog_rows_invalid");}
}
export function parseCatalogSnapshot(value:unknown):CatalogSnapshot{
  try{if(Buffer.byteLength(catalogCanonical(value),"utf8")>CATALOG_SNAPSHOT_BYTES)throw Error();return catalogSnapshotSchema.parse(value);}
  catch{throw new TrialError("trial_catalog_snapshot_invalid");}
}
