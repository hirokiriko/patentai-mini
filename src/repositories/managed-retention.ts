import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import { archiveCheck, archiveDigest, caseTableScope, lockManagedCase, MANAGED_CASE_TABLES, managedGraphManifest, readManagedCaseGraph, type ManagedDatabase, type CaseGraph } from "./managed-case-graph";
import { ManagedArchiveStorage, managedBackupName, managedGraphBlobNames, type ArchiveBlob } from "../lib/patent-watch/managed-archive-storage";
import { managedDeletionEligibleOn } from "../lib/patent-watch/managed-period";
import { managedHash, managedId, ManagedWatchError } from "../lib/patent-watch/managed-types";
const T = schema.managedWatchDeletions, B = schema.managedWatchBackups;
const todayJst = (now: number) => new Date(now + 9 * 60 * 60_000).toISOString().slice(0, 10);
const blob = z.object({ name: z.string().max(500), bytes: z.number().int().nonnegative().max(256 * 1024**2), sha256: managedHash, etag: z.string().min(1).max(200) }).strict();
const manifestSchema = z.object({ schema: z.literal(1), deletionId: z.uuidv4(), caseId: managedId, preparedAt: z.iso.datetime(), eligibleOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tables: z.array(z.object({ table: z.string(), ids: z.array(z.union([z.string(), z.number()])), count: z.number().int().nonnegative(), digest: managedHash }).strict()).length(MANAGED_CASE_TABLES.length),
  backupsDigest: managedHash, backupIds: z.array(z.uuidv4()).max(32), blobs: z.array(blob).max(256), missing: z.array(z.string()).max(256),
}).strict();
export type ManagedDeletionManifest = z.infer<typeof manifestSchema>;

export class ManagedRetentionRepository {
  constructor(private readonly database: ManagedDatabase, private readonly storage: ManagedArchiveStorage) {}
  private async requireInactive(database: ManagedDatabase, graph: CaseGraph, caseId: number, now: number) {
    const setting = graph.managed_watch_settings[0];
    archiveCheck(typeof setting.contract_ends_on === "string" && setting.enabled === false);
    const eligibleOn = managedDeletionEligibleOn(setting.contract_ends_on);
    if (todayJst(now) < eligibleOn) throw new ManagedWatchError("expired");
    if (graph.managed_watch_runs.some(r => ["prepared", "running", "unknown"].includes(String(r.status))) || graph.case_watch_runs.some(r => r.status === "running")) throw new ManagedWatchError("in_progress");
    if (graph.managed_watch_deliveries.some(r => !["stored", "abandoned"].includes(String(r.status)) || (r.status === "abandoned" && now - Date.parse(String(r.created_at)) < 3 * 60_000))) throw new ManagedWatchError("in_progress");
    const jobs = await database.execute(sql`select operation_id from public.managed_watch_job_starts j where j.status <> 'completed'
      and exists(select 1 from jsonb_array_elements(j.config_json::jsonb -> 'runs') r where (r ->> 'caseId')::integer = ${caseId}) limit 1`);
    if (jobs.rows.length) throw new ManagedWatchError("in_progress");
    return eligibleOn;
  }
  private async backups(database: ManagedDatabase, caseId: number) {
    const rows = await database.select().from(B).where(eq(B.caseId, caseId)).orderBy(B.backupId).limit(33);
    archiveCheck(rows.length <= 32);
    if (rows.some(r => !["stored", "abandoned"].includes(r.status))) throw new ManagedWatchError("in_progress");
    return rows;
  }
  /** A preview is immutable and does not delete either DB rows or blobs. */
  async preview(caseId: number, now = Date.now()) {
    return this.database.transaction(async tx => {
      const d = tx as unknown as ManagedDatabase;
      await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`); await lockManagedCase(d, caseId);
      const graph = await readManagedCaseGraph(d, caseId, true), eligibleOn = await this.requireInactive(d, graph, caseId, now), backups = await this.backups(d, caseId);
      const expected = [...managedGraphBlobNames(graph, caseId), ...backups.map(b => managedBackupName(caseId, b.backupId))];
      // Exact, bounded prefix enumeration also records a failed upload's orphan.
      const names = [...new Set([...expected, ...await this.storage.list(caseId)])].sort(); archiveCheck(names.length <= 256);
      const blobs: ArchiveBlob[] = [], missing: string[] = [];
      for (const name of names) {
        const result = await this.storage.read(caseId, name);
        if (result) blobs.push(result.metadata); else missing.push(name);
        await tx.execute(sql`select 1`);
      }
      const manifest = manifestSchema.parse({ schema: 1, deletionId: randomUUID(), caseId, preparedAt: new Date(now).toISOString(), eligibleOn,
        tables: managedGraphManifest(graph), backupsDigest: archiveDigest(backups), backupIds: backups.map(b => b.backupId), blobs, missing });
      const digest = archiveDigest(manifest);
      await tx.insert(T).values({ deletionId: manifest.deletionId, caseId, eligibleOn, manifestJson: JSON.stringify(manifest), manifestDigest: digest, status: "preview" });
      return { deletionId: manifest.deletionId, manifestDigest: digest, eligibleOn, rows: manifest.tables.reduce((n, t) => n + t.count, 0), blobs: blobs.length, missing: missing.length };
    });
  }
  async get(caseId: number, deletionId: string) {
    z.uuidv4().parse(deletionId); managedId.parse(caseId);
    const [row] = await this.database.select().from(T).where(and(eq(T.caseId, caseId), eq(T.deletionId, deletionId)));
    if (!row) throw new ManagedWatchError("not_found");
    const manifest = manifestSchema.parse(JSON.parse(row.manifestJson));
    archiveCheck(manifest.caseId === caseId && manifest.deletionId === deletionId && archiveDigest(manifest) === row.manifestDigest && row.eligibleOn === manifest.eligibleOn);
    return { row, manifest };
  }
  /** A matching explicit digest is required; changed source state requires a new preview. */
  async execute(caseId: number, deletionId: string, approvedDigest: string, now = Date.now()) {
    const { row, manifest } = await this.get(caseId, deletionId);
    archiveCheck(managedHash.parse(approvedDigest) === row.manifestDigest);
    if (todayJst(now) < manifest.eligibleOn) throw new ManagedWatchError("expired");
    if (row.status === "preview") {
      await this.database.transaction(async tx => {
        const d = tx as unknown as ManagedDatabase;
        await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`); await lockManagedCase(d, caseId);
        const graph = await readManagedCaseGraph(d, caseId, true), eligibleOn = await this.requireInactive(d, graph, caseId, now), backups = await this.backups(d, caseId);
        archiveCheck(eligibleOn === manifest.eligibleOn && archiveDigest(managedGraphManifest(graph)) === archiveDigest(manifest.tables) && archiveDigest(backups) === manifest.backupsDigest);
        archiveCheck(archiveDigest(await this.storage.list(caseId)) === archiveDigest(manifest.blobs.map(b => b.name).sort()));
        for (const entry of manifest.blobs) {
          const observed = await this.storage.read(caseId, entry.name); archiveCheck(observed && archiveDigest(observed.metadata) === archiveDigest(entry));
          await tx.execute(sql`select 1`);
        }
        const updated = await tx.update(T).set({ status: "executing" }).where(and(eq(T.deletionId, deletionId), eq(T.status, "preview"))).returning();
        archiveCheck(updated.length === 1);
        await tx.delete(B).where(eq(B.caseId, caseId));
        for (const [table, , kind] of [...MANAGED_CASE_TABLES].reverse()) await tx.execute(sql`delete from ${sql.identifier("public")}.${sql.identifier(table)} t where ${caseTableScope(kind, caseId)}`);
      });
    }
    return this.reconcile(caseId, deletionId, approvedDigest);
  }
  async reconcile(caseId: number, deletionId: string, approvedDigest: string) {
    const { row, manifest } = await this.get(caseId, deletionId);
    archiveCheck(managedHash.parse(approvedDigest) === row.manifestDigest && ["executing", "reconciliation_required", "complete"].includes(row.status));
    try {
      const current = await this.database.execute(sql`select case_id from public.cases where case_id = ${caseId}`); archiveCheck(current.rows.length === 0);
      for (const entry of manifest.blobs) await this.storage.remove(caseId, entry);
      // A timeout/403 is not absence; orphan and missing-reservation checks must be 404.
      for (const name of [...manifest.missing, ...manifest.blobs.map(b => b.name)]) archiveCheck(await this.storage.read(caseId, name) === null);
      archiveCheck((await this.storage.list(caseId)).length === 0);
      for (const item of manifest.tables) {
        const definition = MANAGED_CASE_TABLES.find(([table]) => table === item.table); archiveCheck(definition);
        const [table, key] = definition;
        if (item.ids.length) {
          const found = await this.database.execute(sql`select 1 from ${sql.identifier("public")}.${sql.identifier(table)} where ${sql.identifier(key)}::text = any(${sql.param(item.ids.map(String))}::text[]) limit 1`);
          archiveCheck(found.rows.length === 0);
        }
      }
      await this.database.update(T).set({ status: "complete", completedAt: row.completedAt ?? new Date().toISOString() }).where(eq(T.deletionId, deletionId));
      return { status: "complete", caseId, deletionId, currentBlobsAbsent: true, retainedVersions: "verify_storage_retention_policy" };
    } catch {
      await this.database.update(T).set({ status: "reconciliation_required" }).where(eq(T.deletionId, deletionId));
      throw new ManagedWatchError("outcome_unknown");
    }
  }
}
