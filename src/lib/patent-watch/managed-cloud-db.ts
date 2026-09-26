import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import type { ManagedCloudConfiguration } from "./managed-cloud-config";
import { ManagedWatchError } from "./managed-types";
const check = (value: unknown) => { if (!value) throw new ManagedWatchError("unavailable"); };
const appTables = ["cases","draft_patents","search_query_sets","prior_art_documents","comparison_results","case_watch_settings","case_watch_runs","case_watch_findings",
  "managed_watch_settings","managed_watch_runs","managed_watch_dispatches","managed_watch_findings","managed_watch_deliveries","managed_watch_deletions","managed_watch_job_starts","managed_distribution_snapshots","managed_watch_backups"];
const corpusTables = ["koho_import_runs","koho_import_documents","managed_publication_claims","managed_import_receipts"];
const appSequences = ["cases_case_id_seq","draft_patents_draft_id_seq","search_query_sets_query_set_id_seq","prior_art_documents_doc_id_seq","comparison_results_result_id_seq",
  "case_watch_settings_watch_id_seq","case_watch_runs_run_id_seq","case_watch_findings_finding_id_seq","managed_watch_settings_setting_id_seq","managed_watch_dispatches_dispatch_id_seq","managed_watch_findings_finding_id_seq"];
export async function inspectManagedCloudDatabase(client: Client, target: ManagedCloudConfiguration["target"]) {
  const identity=(await client.query(`select current_database() as db,current_user as usr,current_setting('server_version_num')::int/10000 as major,
    pg_is_in_recovery() as recovery,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
    exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) as member,
    (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls from pg_roles where rolname=current_user`)).rows[0];
  check(identity?.db===target.database&&identity.usr===target.user&&identity.major===16&&identity.tls===true&&!identity.recovery&&
    !identity.rolsuper&&!identity.rolcreatedb&&!identity.rolcreaterole&&!identity.rolreplication&&!identity.rolbypassrls&&!identity.member);
  const access=(await client.query(`select not has_database_privilege(current_database(),'CREATE') and not has_schema_privilege('public','CREATE') as no_create,
    (select bool_and(has_table_privilege(t,'SELECT') and not has_table_privilege(t,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_any_column_privilege(t,'INSERT,UPDATE,REFERENCES')) from unnest($1::text[]) t) as corpus_read,
    (select bool_and(has_table_privilege(t,'SELECT') and has_table_privilege(t,'INSERT') and has_table_privilege(t,'UPDATE')) from unnest($2::text[]) t) as watch_write,
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind in ('r','p','v','m','f') and
      (c.relowner=(select oid from pg_roles where rolname=current_user) or ((n.nspname<>'public' or c.relname<>all($3::text[])) and
      (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))))) as bounded_scope,
    not exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and has_schema_privilege(n.oid,'CREATE')) and
    not exists(select 1 from pg_namespace n,lateral aclexplode(n.nspacl) a where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_attribute at join pg_class c on c.oid=at.attrelid join pg_namespace n on n.oid=c.relnamespace,lateral aclexplode(at.attacl) a
      where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace,lateral aclexplode(c.relacl) a where n.nspname !~ '^pg_' and n.nspname<>'information_schema'
      and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and c.relkind='S' and
      (c.relowner=(select oid from pg_roles where rolname=current_user) or has_sequence_privilege(c.oid,'UPDATE') or
      ((n.nspname<>'public' or c.relname<>all($4::text[])) and has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE')))) as acl_bounded,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname<>'information_schema' and p.prosecdef and has_function_privilege(p.oid,'EXECUTE')) as no_definer`,
    [corpusTables.map(t=>`public.${t}`),["managed_watch_runs","managed_watch_dispatches","managed_watch_findings","managed_watch_job_starts"].map(t=>`public.${t}`),[...appTables,...corpusTables],appSequences])).rows[0];
  check(access?.no_create&&access.corpus_read&&access.watch_write&&access.bounded_scope&&access.acl_bounded&&access.no_definer);
}
/** Uses only the fixed app LOGIN and bounded TLS connection, never a generic DATABASE_URL. */
export async function openManagedCloudDatabase(config:Pick<ManagedCloudConfiguration,"target">,password:string){
  check(typeof password==="string"&&password.length>0&&password.length<=8192);
  const client=new Client({...config.target,password,ssl:{rejectUnauthorized:true,servername:config.target.host},connectionTimeoutMillis:20_000,
    statement_timeout:60_000,query_timeout:65_000,lock_timeout:20_000,idle_in_transaction_session_timeout:60_000,
    options:"-c search_path=pg_catalog,public",application_name:"managed-watch-worker"});
  client.on("error",()=>undefined);
  try{await client.connect();await inspectManagedCloudDatabase(client,config.target);return{client,database:drizzle(client,{schema})};}
  catch{await client.end().catch(()=>undefined);throw new ManagedWatchError("unavailable");}
}
