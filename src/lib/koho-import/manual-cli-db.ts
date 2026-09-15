import type { KohoImportPlan } from "./types";
import type { ManualConfiguration } from "./manual-cli-config";
import { requireManual } from "./manual-cli-config";

export type ManualSaveOutcome = { outcome: "inserted" | "reused" | "failed_before_save" | "save_outcome_unknown"; savedDocumentCount: number };

/** Loaded only after apply admission, parsing and review approval. */
export async function saveManualPlan(config: ManualConfiguration, plan: KohoImportPlan,
  onSaving: () => void): Promise<ManualSaveOutcome> {
  requireManual(config.mode === "apply" && config.connection && config.expectedTarget);
  const [{ Client, DatabaseError }, { drizzle }, schema, { saveKohoImportPlan }] = await Promise.all([
    import("pg"), import("drizzle-orm/node-postgres"), import("../../db/schema"), import("../../repositories/drizzle"),
  ]);
  const c = config.connection;
  const client = new Client({ host: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    ssl: false, connectionTimeoutMillis: 30_000, statement_timeout: 120_000, query_timeout: 125_000,
    lock_timeout: 30_000, idle_in_transaction_session_timeout: 120_000,
    options: "-c search_path=pg_catalog,public", application_name: "koho-manual-local-import" });
  let broken = false, writeAttempted = false, commitSubmitted = false, rollbackConfirmed = false;
  const connectionError = () => { broken = true; };
  client.on("error", connectionError);
  const query = client.query;
  // Observe acknowledgements without logging query text, parameters or driver errors.
  client.query = (async (...args: unknown[]) => {
    const first = args[0];
    const statement = typeof first === "string" ? first : (first as { text?: string })?.text ?? "";
    if (/^\s*(insert|update|delete)\b/i.test(statement)) writeAttempted = true;
    if (/^\s*commit\b/i.test(statement)) commitSubmitted = true;
    let result;
    try { result = await Reflect.apply(query, client, args); }
    catch (error) {
      // A transport failure need not also emit Client's asynchronous error event.
      if (writeAttempted && !(error instanceof DatabaseError)) broken = true;
      throw error;
    }
    if (/^\s*rollback\b/i.test(statement)) rollbackConfirmed = true;
    return result;
  }) as typeof client.query;
  try {
    await client.connect(); requireManual(!broken);
    const identity = (await client.query(`select current_database() as db, current_user as usr,
      current_setting('server_version_num')::int / 10000 as major,
      pg_is_in_recovery() as recovery, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
      exists(select 1 from pg_auth_members where member=(select oid from pg_roles where rolname=current_user)) as member
      from pg_roles where rolname=current_user`)).rows[0];
    requireManual(identity?.db === config.expectedTarget.database && identity?.usr === config.expectedTarget.user &&
      identity.major === 16 && !identity.recovery && !identity.rolsuper && !identity.rolcreatedb &&
      !identity.rolcreaterole && !identity.rolreplication && !identity.rolbypassrls && !identity.member);
    const access = (await client.query(`select
      has_database_privilege(current_database(), 'CONNECT') and
      not has_database_privilege(current_database(), 'CREATE,TEMPORARY') and
      has_schema_privilege('public', 'USAGE') and not has_schema_privilege('public', 'CREATE') as scope_ok,
      (select bool_and(has_table_privilege(t, 'SELECT') and has_table_privilege(t, 'INSERT') and
        not has_table_privilege(t, 'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') and
        not has_any_column_privilege(t, 'UPDATE,REFERENCES'))
        from unnest(array['public.koho_import_runs','public.koho_import_documents']) as t) as tables_ok,
      (select bool_and(has_sequence_privilege(s, 'USAGE') and not has_sequence_privilege(s, 'UPDATE'))
        from unnest(array['public.koho_import_runs_import_id_seq','public.koho_import_documents_document_id_seq']) as s) as sequences_ok,
      not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','f','S') and
        (c.relowner=(select oid from pg_roles where rolname=current_user) or
          (c.relkind <> 'S' and (n.nspname <> 'public' or c.relname not in ('koho_import_runs','koho_import_documents')) and
            (has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') or
             has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))) or
          (c.relkind = 'S' and (n.nspname <> 'public' or c.relname not in ('koho_import_runs_import_id_seq','koho_import_documents_document_id_seq')) and
            has_sequence_privilege(c.oid, 'USAGE,SELECT,UPDATE')))) and
      not exists(select 1 from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
        and has_schema_privilege(n.oid, 'CREATE')) as isolated_ok`)).rows[0];
    requireManual(access?.scope_ok && access.tables_ok && access.sequences_ok && access.isolated_ok && !broken);
    onSaving();
    const result = await saveKohoImportPlan(drizzle(client, { schema }), plan, true);
    requireManual(!broken && result.savedDocumentCount === plan.documentCount &&
      (result.disposition === "inserted" || result.disposition === "reused"));
    return { outcome: result.disposition, savedDocumentCount: result.savedDocumentCount };
  } catch {
    // A rollback after an unacknowledged COMMIT cannot establish that COMMIT failed.
    return { outcome: commitSubmitted || (writeAttempted && (!rollbackConfirmed || broken))
      ? "save_outcome_unknown" : "failed_before_save", savedDocumentCount: 0 };
  } finally {
    await client.end().catch(() => undefined);
    client.removeListener("error", connectionError);
  }
}
