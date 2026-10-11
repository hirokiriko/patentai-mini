import { createHash } from "node:crypto";

// Source literals only. No caller supplies SQL, an identifier, or a LIMIT.
export const CATALOG_ROW_LIMIT = 16384;
export const CATALOG_QUERY_BYTES = 8 * 1024 ** 2;
export const CATALOG_SNAPSHOT_BYTES = 16 * 1024 ** 2;
const acl = (expression: string, kind: string, owner: string) => explicitAcl(`COALESCE(${expression},pg_catalog.acldefault('${kind}'::pg_catalog."char",${owner}))`);
const explicitAcl = (expression: string) => `COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(a.grantor::pg_catalog.int8,a.grantee::pg_catalog.int8,a.privilege_type,a.is_grantable) ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable) FROM pg_catalog.aclexplode(${expression}) a),'[]'::pg_catalog.jsonb)`;
const select = (sql: string) => sql + ` LIMIT ${CATALOG_ROW_LIMIT + 1}`;
export const CATALOG_QUERIES = Object.freeze({
  begin: "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  commit: "COMMIT",
  identity: "SELECT pg_catalog.current_database() AS database,current_user AS username,pg_catalog.current_setting('server_version_num') AS version,pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('transaction_read_only') AS readonly,pg_catalog.current_setting('search_path') AS search_path",
  inventory: select(`SELECT d.oid,d.datname,d.datdba,d.datistemplate,d.datallowconn,${acl("d.datacl", "d", "d.datdba")} AS datacl FROM pg_catalog.pg_database d ORDER BY d.oid`),
  roles: select("SELECT r.oid,r.rolname,r.rolsuper,r.rolinherit,r.rolcreaterole,r.rolcreatedb,r.rolcanlogin,r.rolreplication,r.rolbypassrls,r.rolconnlimit,r.rolvaliduntil::pg_catalog.text AS rolvaliduntil,r.rolconfig IS NOT NULL AS has_settings FROM pg_catalog.pg_roles r ORDER BY r.oid"),
  members: select("SELECT m.roleid,m.member,m.grantor,m.admin_option,m.inherit_option,m.set_option FROM pg_catalog.pg_auth_members m ORDER BY m.member,m.roleid,m.grantor"),
  settings: select("SELECT s.setdatabase,s.setrole,s.setconfig IS NOT NULL AS has_settings FROM pg_catalog.pg_db_role_setting s ORDER BY s.setdatabase,s.setrole"),
  namespaces: select(`SELECT n.oid,n.nspname,n.nspowner,${acl("n.nspacl", "n", "n.nspowner")} AS nspacl FROM pg_catalog.pg_namespace n ORDER BY n.oid`),
  relations: select(`SELECT c.oid,c.relnamespace,c.relname,c.relowner,c.relkind,CASE WHEN c.relkind='S' THEN ${acl("c.relacl", "s", "c.relowner")} ELSE ${acl("c.relacl", "r", "c.relowner")} END AS relacl FROM pg_catalog.pg_class c WHERE c.relkind IN ('r','p','v','m','f','S') ORDER BY c.oid`),
  columns: select(`SELECT a.attrelid,a.attnum,a.attisdropped,${explicitAcl("a.attacl")} AS attacl FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL AND c.relkind IN ('r','p','v','m','f','S') ORDER BY a.attrelid,a.attnum`),
  routines: select(`SELECT p.oid,p.pronamespace,p.proname,p.proowner,p.prokind,p.prosecdef,p.prolang,p.proargtypes::pg_catalog.text AS proargtypes,p.prorettype,${acl("p.proacl", "f", "p.proowner")} AS proacl FROM pg_catalog.pg_proc p ORDER BY p.oid`),
  defaults: select(`SELECT d.oid,d.defaclrole,d.defaclnamespace,d.defaclobjtype,${explicitAcl("d.defaclacl")} AS defaclacl FROM pg_catalog.pg_default_acl d ORDER BY d.oid`),
  largeObjects: select(`SELECT l.oid,l.lomowner,${acl("l.lomacl", "L", "l.lomowner")} AS lomacl FROM pg_catalog.pg_largeobject_metadata l ORDER BY l.oid`),
  types: select(`SELECT t.oid,t.typnamespace,t.typname,t.typowner,t.typtype,t.typrelid,t.typelem,t.typarray,t.typbasetype,t.typinput::pg_catalog.oid AS typinput,t.typoutput::pg_catalog.oid AS typoutput,t.typreceive::pg_catalog.oid AS typreceive,t.typsend::pg_catalog.oid AS typsend,t.typmodin::pg_catalog.oid AS typmodin,t.typmodout::pg_catalog.oid AS typmodout,t.typanalyze::pg_catalog.oid AS typanalyze,t.typsubscript::pg_catalog.oid AS typsubscript,${acl("t.typacl", "T", "t.typowner")} AS typacl FROM pg_catalog.pg_type t ORDER BY t.oid`),
  foreignServers: select(`SELECT s.oid,s.srvowner,s.srvfdw,${acl("s.srvacl", "S", "s.srvowner")} AS srvacl FROM pg_catalog.pg_foreign_server s ORDER BY s.oid`),
  foreignWrappers: select(`SELECT f.oid,f.fdwowner,f.fdwhandler::pg_catalog.oid AS fdwhandler,f.fdwvalidator::pg_catalog.oid AS fdwvalidator,${acl("f.fdwacl", "F", "f.fdwowner")} AS fdwacl FROM pg_catalog.pg_foreign_data_wrapper f ORDER BY f.oid`),
  extensions: select("SELECT e.oid,e.extname,e.extowner,e.extnamespace,e.extversion FROM pg_catalog.pg_extension e ORDER BY e.oid"),
  extensionMembers: select("SELECT d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid,d.deptype FROM pg_catalog.pg_depend d WHERE d.deptype='e' ORDER BY d.classid,d.objid,d.objsubid,d.refclassid,d.refobjid,d.refobjsubid"),
  parameters: select(`SELECT p.oid,p.parname,${explicitAcl("p.paracl")} AS paracl FROM pg_catalog.pg_parameter_acl p ORDER BY p.oid`),
});
export type CatalogQueryId = keyof typeof CATALOG_QUERIES;
export const CATALOG_PACK = Object.freeze(["roles", "members", "settings", "namespaces", "relations", "columns", "routines", "defaults", "largeObjects", "types", "foreignServers", "foreignWrappers", "extensions", "extensionMembers", "parameters"] as const);
export function catalogCanonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(catalogCanonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + catalogCanonical((value as Record<string, unknown>)[k])).join(",") + "}";
  const result = JSON.stringify(value);
  if (result === undefined || (typeof value === "number" && !Number.isFinite(value))) throw new Error("catalog_canonical_invalid");
  return result;
}
export const catalogDigest = (value: unknown) => createHash("sha256").update(catalogCanonical(value), "utf8").digest("hex");
export const CATALOG_QUERY_SET_SHA256 = catalogDigest(CATALOG_QUERIES);
