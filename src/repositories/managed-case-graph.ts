import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { managedDigest } from "../lib/patent-watch/managed-claims";
import { managedId, ManagedWatchError } from "../lib/patent-watch/managed-types";

export type ManagedDatabase = NodePgDatabase<typeof schema>;
// These identifiers are constants, never supplied by an archive or operator input.
export const MANAGED_CASE_TABLES = [
  ["cases", "case_id", "case"], ["draft_patents", "draft_id", "case"], ["search_query_sets", "query_set_id", "case"],
  ["prior_art_documents", "doc_id", "case"], ["comparison_results", "result_id", "case"],
  ["case_watch_settings", "watch_id", "case"], ["case_watch_runs", "run_id", "legacy"], ["case_watch_findings", "finding_id", "legacy"],
  ["managed_watch_settings", "setting_id", "case"], ["managed_watch_runs", "run_id", "case"],
  ["managed_watch_dispatches", "dispatch_id", "run"], ["managed_watch_findings", "finding_id", "setting"],
  ["managed_watch_deliveries", "delivery_id", "case"],
] as const;
export type CaseTable = typeof MANAGED_CASE_TABLES[number][0];
export type CaseGraph = Record<CaseTable, Record<string, unknown>[]>;
export function archiveCheck(ok: unknown): asserts ok { if (!ok) throw new ManagedWatchError("incomplete"); }
export function canonicalManaged(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalManaged);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalManaged(v)]));
  return value;
}
export const archiveDigest = (value: unknown) => managedDigest(canonicalManaged(value));
export function caseTableScope(kind: typeof MANAGED_CASE_TABLES[number][2], caseId: number): SQL {
  switch (kind) {
    case "case": return sql`t.case_id = ${caseId}`;
    case "legacy": return sql`t.watch_id in (select watch_id from public.case_watch_settings where case_id = ${caseId})`;
    case "setting": return sql`t.setting_id in (select setting_id from public.managed_watch_settings where case_id = ${caseId})`;
    case "run": return sql`t.run_id in (select run_id from public.managed_watch_runs where case_id = ${caseId})`;
  }
}
export async function lockManagedCase(database: ManagedDatabase, caseId: number) {
  managedId.parse(caseId);
  await database.execute(sql`select pg_advisory_xact_lock(129, ${caseId}::integer)`);
}
export async function readManagedCaseGraph(database: ManagedDatabase, caseId: number, lock = false): Promise<CaseGraph> {
  managedId.parse(caseId);
  const graph = {} as CaseGraph; let bytes = 0;
  for (const [table, key, kind] of MANAGED_CASE_TABLES) {
    if (lock) {
      const ids = await database.execute(sql`select ${sql.identifier(key)} from ${sql.identifier("public")}.${sql.identifier(table)} t
        where ${caseTableScope(kind, caseId)} order by ${sql.identifier(key)} limit 20001 for update`);
      archiveCheck(ids.rows.length <= 20_000);
    }
    // Reject oversized content in PostgreSQL before transferring any full row.
    const size = await database.execute(sql`select count(*) as n, coalesce(sum(octet_length(to_jsonb(t)::text)),0) as bytes
      from ${sql.identifier("public")}.${sql.identifier(table)} t where ${caseTableScope(kind, caseId)}`);
    bytes += Number(size.rows[0].bytes);
    archiveCheck(Number(size.rows[0].n) <= 20_000 && bytes <= 64 * 1024**2);
    const result = await database.execute(sql`select to_jsonb(t) as row from ${sql.identifier("public")}.${sql.identifier(table)} t
      where ${caseTableScope(kind, caseId)} order by ${sql.identifier(key)} limit 20001 ${lock ? sql`for update` : sql``}`);
    const rows = result.rows.map(r => r.row as Record<string, unknown>);
    archiveCheck(rows.length <= 20_000);
    graph[table] = rows;
  }
  archiveCheck(graph.cases.length === 1 && graph.managed_watch_settings.length === 1);
  const setting = graph.managed_watch_settings[0], runIds = new Set(graph.managed_watch_runs.map(r => r.run_id));
  archiveCheck(graph.managed_watch_runs.every(r => r.setting_id === setting.setting_id && r.case_id === caseId));
  archiveCheck(graph.managed_watch_deliveries.every(r => r.setting_id === setting.setting_id && r.case_id === caseId));
  archiveCheck(graph.managed_watch_findings.every(r => r.setting_id === setting.setting_id && runIds.has(r.run_id)));
  return graph;
}
export function managedGraphManifest(graph: CaseGraph) {
  return MANAGED_CASE_TABLES.map(([table, key]) => ({ table, ids: graph[table].map(row => row[key]), count: graph[table].length, digest: archiveDigest(graph[table]) }));
}
/** The lock spans Blob upload AND DB registration; deletion takes the same lock. */
export async function withManagedOriginalUpload<T>(database: ManagedDatabase, caseId: number, operation: () => Promise<T>): Promise<T> {
  return database.transaction(async tx => {
    await lockManagedCase(tx as unknown as ManagedDatabase, caseId);
    const found = await tx.execute(sql`select case_id from public.cases where case_id = ${caseId}`);
    if (found.rows.length !== 1) throw new ManagedWatchError("not_found");
    return operation();
  });
}
