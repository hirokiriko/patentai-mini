import { Client, DatabaseError, type QueryConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema";
import { saveKohoImportPlan } from "../../repositories/drizzle";
import { requireManual } from "./manual-cli-config";
import type { CloudConfiguration, CloudManifest } from "./cloud-config";
import type { KohoImportPlan } from "./types";
import type { ManualSaveOutcome } from "./manual-cli-db";
import type { projectManagedPackage } from "./managed-package";
import { isManagedExecutionApproval } from "../patent-watch/managed-budget-contract";

export type CloudSaveResult = ManualSaveOutcome & { databaseGrowthBytes: number; capacityConfirmed: boolean };
type SaveConfiguration = Pick<CloudConfiguration, "mode" | "approval" | "expectedTarget">;
type SaveManifest = Pick<CloudManifest, "expiresAt" | "maxElapsedMs" | "reservedGrowthBytes" | "maxDatabaseBytes"> & {
  packages: Array<{ packageType: "JPA" | "JPB"; sha256: string; expectedDisposition: "inserted" | "reused" }>;
};
const tables = ["koho_import_runs", "koho_import_documents"];
const expectedColumns = {
  koho_import_runs: ["import_id", "package_type", "source_sha256", "package_status", "document_count", "amendment_count", "nested_st26_count", "counts_json", "issues_json", "created_at", "updated_at"],
  koho_import_documents: ["document_id", "import_id", "normalized_entry_path", "parse_status", "kind", "publication_number", "application_number", "publication_date", "registration_number", "registration_date", "invention_title", "abstract_text", "claims_text", "applicants_json", "ipc_json", "fi_json", "parse_issues_json", "source_metadata_json", "content_sha256"],
  managed_publication_claims: ["document_id", "content_sha256", "source_sha256", "claims_json", "claims_digest", "status", "reason", "created_at"],
  managed_import_receipts: ["import_id", "source_sha256", "publication_date", "issue_number", "receipt_json", "receipt_digest"],
};

/** Server-side identity, TLS, exact corpus shape and directly bounded role scope. */
export async function inspectCloudDatabase(client: Client, target: CloudConfiguration["expectedTarget"], managed = false) {
  const allowedTables = managed ? [...tables, "managed_publication_claims", "managed_import_receipts"] : tables;
  const identity = (await client.query(`select current_database() as db, current_user as usr,
    current_setting('server_version_num')::int / 10000 as major, pg_is_in_recovery() as recovery,
    rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
    exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) as member,
    (select ssl from pg_stat_ssl where pid=pg_backend_pid()) as tls
    from pg_roles where rolname=current_user`)).rows[0];
  requireManual(identity?.db === target.database && identity.usr === target.user && identity.major === 16 && identity.tls === true &&
    !identity.recovery && !identity.rolsuper && !identity.rolcreatedb && !identity.rolcreaterole && !identity.rolreplication && !identity.rolbypassrls && !identity.member);
  const access = (await client.query(`select
    has_database_privilege(current_database(), 'CONNECT') and not has_database_privilege(current_database(), 'CREATE') and
    has_schema_privilege('public', 'USAGE') and not has_schema_privilege('public', 'CREATE') and
    not exists(select 1 from pg_database d, lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      where d.datname=current_database() and a.grantee=(select oid from pg_roles where rolname=current_user)
      and (a.privilege_type <> 'CONNECT' or a.is_grantable)) and
    (not has_database_privilege(current_database(),'TEMPORARY') or exists(
      select 1 from pg_database d, lateral aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a
      where d.datname=current_database() and a.grantee=0 and a.privilege_type='TEMPORARY')) as scope_ok,
    (select bool_and(has_table_privilege(t,'SELECT') and has_table_privilege(t,'INSERT') and
      not has_table_privilege(t,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and not has_any_column_privilege(t,'UPDATE,REFERENCES'))
      from unnest($1::text[]) t) as tables_ok,
    (select bool_and(has_sequence_privilege(s,'USAGE') and not has_sequence_privilege(s,'SELECT,UPDATE'))
      from unnest(array['public.koho_import_runs_import_id_seq','public.koho_import_documents_document_id_seq']) s) as sequences_ok,
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f','S') and
      (c.relowner=(select oid from pg_roles where rolname=current_user) or
        (c.relkind <> 'S' and (n.nspname <> 'public' or c.relname <> all($2::text[])) and
          (has_table_privilege(c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or has_any_column_privilege(c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))) or
        (c.relkind='S' and (n.nspname <> 'public' or c.relname not in ('koho_import_runs_import_id_seq','koho_import_documents_document_id_seq')) and
          has_sequence_privilege(c.oid,'USAGE,SELECT,UPDATE')))) and
    not exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and has_schema_privilege(n.oid,'CREATE')) and
    not exists(select 1 from pg_namespace n, lateral aclexplode(n.nspacl) a where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_attribute at join pg_class c on c.oid=at.attrelid join pg_namespace n on n.oid=c.relnamespace,
      lateral aclexplode(at.attacl) a where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace,
      lateral aclexplode(c.relacl) a where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and a.grantee=(select oid from pg_roles where rolname=current_user) and a.is_grantable) and
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
      and p.prosecdef and has_function_privilege(p.oid,'EXECUTE')) as isolated_ok`, [allowedTables.map(t=>`public.${t}`), allowedTables])).rows[0];
  requireManual(access?.scope_ok && access.tables_ok && access.sequences_ok && access.isolated_ok);
  const relations = (await client.query(`select c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity,
    exists(select 1 from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal) as triggers,
    exists(select 1 from pg_rewrite r where r.ev_class=c.oid) as rules
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1)`, [allowedTables])).rows;
  requireManual(relations.length === allowedTables.length && relations.every(r => r.relkind === "r" && !r.relrowsecurity && !r.relforcerowsecurity && !r.triggers && !r.rules));
  const columns = (await client.query(`select c.relname, a.attname, format_type(a.atttypid,a.atttypmod) as type, a.attnotnull,
    pg_get_expr(d.adbin,d.adrelid) as def, a.attgenerated, a.attidentity
    from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid
    left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
    where n.nspname='public' and c.relname=any($1) and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`, [allowedTables])).rows;
  for (const table of allowedTables) {
    const actual = columns.filter(c => c.relname === table), expected = expectedColumns[table as keyof typeof expectedColumns];
    requireManual(actual.length === expected.length && actual.every((c, i) => {
      const name = expected[i], serial = tables.includes(table) && name === (table === "koho_import_runs" ? "import_id" : "document_id");
      const timestamp = ["created_at", "updated_at"].includes(name);
      const integer = ["import_id", "document_id", "document_count", "amendment_count", "nested_st26_count"].includes(name);
      const nullable = ["registration_number", "registration_date", "abstract_text", "claims_json", "claims_digest", "reason"].includes(name);
      const validDefault = serial ? [ `nextval('${table}_${name}_seq'::regclass)`, `nextval('public.${table}_${name}_seq'::regclass)` ].includes(c.def) : timestamp ? c.def === "now()" : c.def === null;
      return c.attname === name && c.type === (timestamp ? "timestamp with time zone" : integer ? "integer" : "text") && c.attnotnull === !nullable && !c.attgenerated && !c.attidentity && validDefault;
    }));
  }
  const indexes = (await client.query(`select c.relname, i.indisprimary, array(select a.attname::text from unnest(i.indkey) with ordinality k(num,ord)
    join pg_attribute a on a.attrelid=c.oid and a.attnum=k.num order by k.ord) as columns
    from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any($1) and i.indisunique and i.indisvalid and i.indisready and i.indimmediate
    and i.indpred is null and i.indexprs is null`, [tables])).rows;
  for (const [table, names, primary] of [[tables[0], ["import_id"], true], [tables[1], ["document_id"], true],
    [tables[0], ["package_type", "source_sha256"], false], [tables[1], ["import_id", "normalized_entry_path"], false]] as const) {
    requireManual(indexes.some(i => i.relname === table && i.indisprimary === primary && JSON.stringify(i.columns) === JSON.stringify(names)));
  }
  const foreignKeys = (await client.query(`select pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid='public.koho_import_documents'::regclass and contype='f' and convalidated and not condeferrable`)).rows;
  requireManual(foreignKeys.length === 1 && /^FOREIGN KEY \(import_id\) REFERENCES (public\.)?koho_import_runs\(import_id\) ON DELETE CASCADE$/.test(foreignKeys[0].def));
}

/** ACK of COMMIT and ACK of receipt storage are deliberately independent. */
export async function saveCloudPlan(config: CloudConfiguration, manifest: CloudManifest, password: string, plan: KohoImportPlan,
  onSaving: () => void, createClient?: () => Client, managed?: ReturnType<typeof projectManagedPackage>,
  execution?: { deadline: number; signal?: AbortSignal }): Promise<CloudSaveResult> {
  return saveCloudPlanInternal(config, manifest, password, plan, onSaving, createClient, managed, execution, false);
}

/** The Web worker accepts either immutable insert/reuse under the existing DB
 * advisory lock. The legacy approved-manifest disposition remains strict. */
export async function saveUploadedCloudPlan(config: SaveConfiguration, manifest: SaveManifest, password: string, plan: KohoImportPlan,
  onSaving: () => void, createClient: (() => Client) | undefined, managed: ReturnType<typeof projectManagedPackage>,
  execution: { deadline: number; signal?: AbortSignal }): Promise<CloudSaveResult> {
  requireManual(isManagedExecutionApproval(config.approval) && !!managed);
  return saveCloudPlanInternal(config, manifest, password, plan, onSaving, createClient, managed, execution, true);
}

async function saveCloudPlanInternal(config: SaveConfiguration, manifest: SaveManifest, password: string, plan: KohoImportPlan,
  onSaving: () => void, createClient: (() => Client) | undefined, managed: ReturnType<typeof projectManagedPackage> | undefined,
  execution: { deadline: number; signal?: AbortSignal } | undefined, acceptImmutableReuse: boolean): Promise<CloudSaveResult> {
  requireManual(config.mode === "apply" && typeof password === "string" && password.length > 0 && password.length <= 8192);
  requireManual(isManagedExecutionApproval(config.approval) === !!managed);
  const budget = execution ?? { deadline: performance.now() + manifest.maxElapsedMs };
  const remaining = () => Math.floor(Math.min(budget.deadline - performance.now(), Date.parse(manifest.expiresAt) - Date.now()));
  requireManual(Number.isFinite(budget.deadline) && remaining() > 0 && !budget.signal?.aborted);
  const client = createClient?.() ?? new Client({ ...config.expectedTarget, password, ssl: { rejectUnauthorized: true, servername: config.expectedTarget.host },
    connectionTimeoutMillis: 30_000, statement_timeout: 120_000, query_timeout: 125_000, lock_timeout: 30_000,
    idle_in_transaction_session_timeout: 120_000, options: "-c search_path=pg_catalog,public", application_name: "koho-cloud-pilot-import" });
  let broken = false, writeAttempted = false, commitSubmitted = false, rollbackConfirmed = false;
  let saved: CloudSaveResult | undefined;
  const connectionError = () => { broken = true; }; client.on("error", connectionError);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= client.end().catch(() => undefined);
  const interrupt = () => { void close(); };
  const timer = setTimeout(interrupt, remaining());
  budget.signal?.addEventListener("abort", interrupt, { once: true });
  const query = client.query;
  client.query = (async (...args: unknown[]) => {
    const first = args[0], statement = typeof first === "string" ? first : (first as { text?: string })?.text ?? "";
    const rollback = /^\s*rollback\b/i.test(statement);
    if (!rollback) {
      requireManual(!budget.signal?.aborted && remaining() > 0);
      const timeout = Math.max(1, Math.min(remaining(), 120_000));
      // Dedicated connection; trusted numeric timeout only. Never reset the run deadline per chunk.
      await Reflect.apply(query, client, [{ text: `set statement_timeout = ${timeout}; set lock_timeout = ${Math.min(timeout, 30_000)}`,
        query_timeout: timeout }]);
      requireManual(!budget.signal?.aborted && remaining() > 0);
    }
    if (/^\s*(insert|update|delete)\b/i.test(statement)) writeAttempted = true;
    if (/^\s*commit\b/i.test(statement)) commitSubmitted = true;
    const originalConfig: QueryConfig = typeof first === "string" ? { text: first } : first as QueryConfig;
    const bounded: QueryConfig & { query_timeout: number } = { ...originalConfig, values: (args[1] as unknown[] | undefined) ?? originalConfig.values,
      query_timeout: rollback ? 5000 : Math.max(1, Math.min(remaining(), 125_000)) };
    let result;
    try { result = await Reflect.apply(query, client, [bounded]); }
    catch (error) { if (writeAttempted && !(error instanceof DatabaseError)) broken = true; throw error; }
    if (/^\s*rollback\b/i.test(statement)) rollbackConfirmed = true;
    return result;
  }) as typeof client.query;
  try {
    await client.connect(); await inspectCloudDatabase(client, config.expectedTarget, !!managed);
    const before = Number((await client.query("select pg_database_size(current_database())::text as bytes")).rows[0]?.bytes);
    requireManual(!broken && Number.isSafeInteger(before) && before > 0 && before + manifest.reservedGrowthBytes <= manifest.maxDatabaseBytes && Date.now() < Date.parse(manifest.expiresAt));
    const approved = manifest.packages.find(p => p.sha256 === plan.sourceSha256 && p.packageType === plan.packageType);
    requireManual(approved);
    const existing = (await client.query("select count(*)::int as count from public.koho_import_runs where package_type=$1 and source_sha256=$2", [plan.packageType, plan.sourceSha256])).rows[0]?.count;
    requireManual(acceptImmutableReuse ? existing === 0 || existing === 1 : existing === (approved.expectedDisposition === "reused" ? 1 : 0));
    onSaving();
    const result = await saveKohoImportPlan(drizzle(client, { schema }), plan, true, acceptImmutableReuse ? undefined : approved.expectedDisposition, managed?.sources, managed?.receipt);
    requireManual(result.savedDocumentCount === plan.documentCount && (result.disposition === "inserted" || result.disposition === "reused"));
    saved = { outcome: result.disposition, savedDocumentCount: result.savedDocumentCount, databaseGrowthBytes: 0, capacityConfirmed: false };
    requireManual(!broken);
    const after = Number((await client.query("select pg_database_size(current_database())::text as bytes")).rows[0]?.bytes);
    requireManual(!broken && Number.isSafeInteger(after) && after > 0);
    saved.databaseGrowthBytes = Math.max(0, after - before);
    saved.capacityConfirmed = after <= manifest.maxDatabaseBytes && saved.databaseGrowthBytes <= manifest.reservedGrowthBytes &&
      (acceptImmutableReuse || result.disposition === approved.expectedDisposition);
    return saved;
  } catch {
    return saved ?? { outcome: commitSubmitted || (writeAttempted && (!rollbackConfirmed || broken)) ? "save_outcome_unknown" : "failed_before_save",
      savedDocumentCount: 0, databaseGrowthBytes: 0, capacityConfirmed: false };
  } finally { clearTimeout(timer); budget.signal?.removeEventListener("abort", interrupt); await close(); client.query = query; client.removeListener("error", connectionError); }
}
