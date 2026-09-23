import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import * as schema from "../db/schema";
import { archiveCheck, archiveDigest, canonicalManaged, lockManagedCase, readManagedCaseGraph, MANAGED_CASE_TABLES, type ManagedDatabase, type CaseGraph } from "./managed-case-graph";
import { archiveSha, ManagedArchiveStorage, managedBackupName, managedGraphBlobNames, validManagedCaseBlob } from "../lib/patent-watch/managed-archive-storage";
import { managedHash, managedId, ManagedWatchError } from "../lib/patent-watch/managed-types";
import { managedArtifactName, validateManagedArtifactManifest } from "../lib/patent-watch/managed-storage";
import { managedBaseSourceSchema, verifyManagedBaseOriginal } from "../lib/patent-watch/managed-base-source";
import { parseUploadedOriginalFileMetadata } from "../lib/original-file-metadata";
const B = schema.managedWatchBackups;
export const MANAGED_BACKUP_REFERENCES = [["koho_import_runs", "import_id"], ["koho_import_documents", "document_id"], ["managed_distribution_snapshots", "sha256"]] as const;
type References = Record<typeof MANAGED_BACKUP_REFERENCES[number][0], Record<string, unknown>[]>;
const archiveSchema = z.object({ schema: z.literal(1), backupId: z.uuidv4(), caseId: managedId, createdAt: z.iso.datetime(),
  graph: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(20_000)),
  references: z.record(z.string(), z.array(z.record(z.string(), z.unknown())).max(20_000)),
  artifacts: z.array(z.object({ name: z.string().max(500), bytes: z.number().int().nonnegative().max(50 * 1024**2), sha256: managedHash, data: z.string().max(70 * 1024**2) }).strict()).max(256),
  missingArtifacts: z.array(z.string().max(500)).max(256),
}).strict();
export type ManagedCaseBackup = z.infer<typeof archiveSchema>;
export function parseManagedCaseBackup(bytes: Buffer, expectedSha: string, caseId: number, backupId: string): ManagedCaseBackup {
  archiveCheck(bytes.length <= 256 * 1024**2 && archiveSha(bytes) === managedHash.parse(expectedSha));
  const result = archiveSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  archiveCheck(result.caseId === caseId && result.backupId === backupId &&
    archiveDigest(Object.keys(result.graph).sort()) === archiveDigest(MANAGED_CASE_TABLES.map(([t]) => t).sort()) &&
    archiveDigest(Object.keys(result.references).sort()) === archiveDigest(MANAGED_BACKUP_REFERENCES.map(([t]) => t).sort()));
  archiveCheck(result.graph.cases.length === 1 && result.graph.cases[0].case_id === caseId && result.graph.managed_watch_settings.length === 1);
  for (const [table, , kind] of MANAGED_CASE_TABLES) if (kind === "case") archiveCheck(result.graph[table].every(row => row.case_id === caseId));
  const archivedNames = [...result.artifacts.map(a => a.name), ...result.missingArtifacts];
  archiveCheck(new Set(archivedNames).size === archivedNames.length &&
    archiveDigest(archivedNames.sort()) === archiveDigest(managedGraphBlobNames(result.graph as CaseGraph, caseId)));
  const permittedMissing = abandonedArtifactNames(result.graph as CaseGraph, caseId);
  archiveCheck(result.missingArtifacts.every(name => permittedMissing.has(name)));
  for (const item of result.artifacts) {
    archiveCheck(validManagedCaseBlob(item.name, caseId) && !item.name.includes("/managed-backups/"));
    const data = Buffer.from(item.data, "base64"); archiveCheck(data.toString("base64") === item.data && data.length === item.bytes && archiveSha(data) === item.sha256);
  }
  for (const row of result.graph.managed_watch_deliveries) {
    archiveCheck(row.status === "stored" || row.status === "abandoned");
    if (row.status === "abandoned" && row.blob_manifest_json === null) continue;
    archiveCheck(typeof row.blob_manifest_json === "string");
    const manifest = validateManagedArtifactManifest(JSON.parse(row.blob_manifest_json), caseId, String(row.delivery_id));
    for (const expected of manifest.artifacts) {
      const actual = result.artifacts.find(a => a.name === managedArtifactName(caseId, manifest.deliveryId, expected.kind));
      if (!actual && row.status === "abandoned") continue;
      archiveCheck(actual && actual.bytes === expected.bytes && actual.sha256 === expected.sha256);
      if (expected.kind === "snapshot") archiveCheck(archiveDigest(JSON.parse(Buffer.from(actual.data, "base64").toString("utf8"))) === archiveDigest(JSON.parse(String(row.snapshot_json))));
    }
  }
  // Revalidate the original-to-claims binding, including originals retained by older runs.
  const settings = result.graph.managed_watch_settings.map(row => ({ source: JSON.parse(String(row.source_json)), base: JSON.parse(String(row.base_claims_json)), documentId: row.source_document_id }));
  for (const row of result.graph.managed_watch_runs) {
    const snapshot = JSON.parse(String(row.snapshot_json));
    settings.push({ source: snapshot.setting.source, base: snapshot.setting.base, documentId: row.source_document_id });
  }
  for (const setting of settings) {
    const source = managedBaseSourceSchema.parse(setting.source); archiveCheck(source.documentId === setting.documentId);
    const original = result.graph.prior_art_documents.find(row => row.doc_id === source.documentId);
    archiveCheck(original);
    const metadata = parseUploadedOriginalFileMetadata(original.source_csv_row_json as string | null); archiveCheck(metadata);
    const artifact = result.artifacts.find(a => a.name === metadata.blobName); archiveCheck(artifact && artifact.bytes === metadata.size);
    verifyManagedBaseOriginal(Buffer.from(artifact.data, "base64"), source, setting.base);
  }
  return result;
}
function abandonedArtifactNames(graph: CaseGraph, caseId: number) {
  const names = new Set<string>();
  for (const row of graph.managed_watch_deliveries) if (row.status === "abandoned" && row.blob_manifest_json) {
    const manifest = validateManagedArtifactManifest(JSON.parse(String(row.blob_manifest_json)), caseId, String(row.delivery_id));
    for (const item of manifest.artifacts) names.add(managedArtifactName(caseId, manifest.deliveryId, item.kind));
  }
  return names;
}
export class ManagedBackupRepository {
  constructor(private readonly database: ManagedDatabase, private readonly storage: ManagedArchiveStorage) {}
  async create(caseId: number, backupId: string) {
    managedId.parse(caseId); z.uuidv4().parse(backupId);
    let bytes: Buffer;
    // Reserve the exact digest before any cloud write. The input id is never regenerated on retry.
    const reservation = await this.database.transaction(async tx => {
      const d = tx as unknown as ManagedDatabase;
      await tx.execute(sql`select pg_advisory_xact_lock(129129::bigint)`); await lockManagedCase(d, caseId);
      const existing = await tx.select().from(B).where(eq(B.backupId, backupId));
      if (existing.length) throw new ManagedWatchError("conflict");
      const count = await tx.select({ id: B.backupId }).from(B).where(eq(B.caseId, caseId)).limit(32); archiveCheck(count.length < 32);
      const graph = await readManagedCaseGraph(d, caseId, true);
      if (graph.managed_watch_runs.some(r => ["prepared", "running", "unknown"].includes(String(r.status))) ||
        graph.managed_watch_deliveries.some(r => !["stored", "abandoned"].includes(String(r.status))) || graph.case_watch_runs.some(r => r.status === "running")) throw new ManagedWatchError("in_progress");
      let referenceBytes = Buffer.byteLength(JSON.stringify(graph));
      const readReferences = async (table: typeof MANAGED_BACKUP_REFERENCES[number][0], key: string, ids: unknown[], type: "integer" | "text") => {
        if (!ids.length) return [];
        const condition = sql`${sql.identifier(key)} = any(${sql.param(ids)}::${sql.raw(type)}[])`;
        const size = await tx.execute(sql`select count(*) as n, coalesce(sum(octet_length(to_jsonb(t)::text)),0) as bytes from ${sql.identifier("public")}.${sql.identifier(table)} t where ${condition}`);
        referenceBytes += Number(size.rows[0].bytes); archiveCheck(Number(size.rows[0].n) <= 20_000 && referenceBytes <= 64 * 1024**2);
        return (await tx.execute(sql`select to_jsonb(t) as row from ${sql.identifier("public")}.${sql.identifier(table)} t where ${condition} order by ${sql.identifier(key)}`)).rows.map(r => r.row as Record<string, unknown>);
      };
      const corpusIds = [...new Set(graph.case_watch_findings.map(r => r.corpus_document_id).filter(id => id !== null))];
      const corpus = await readReferences("koho_import_documents", "document_id", corpusIds, "integer");
      const importIds = [...new Set(corpus.map(r => r.import_id))];
      const imports = await readReferences("koho_import_runs", "import_id", importIds, "integer");
      const hashes = [...new Set(graph.managed_watch_deliveries.map(r => r.distribution_sha256))];
      const distribution = await readReferences("managed_distribution_snapshots", "sha256", hashes, "text");
      archiveCheck(corpus.length === corpusIds.length && imports.length === importIds.length && distribution.length === hashes.length);
      const references: References = { koho_import_runs: imports, koho_import_documents: corpus, managed_distribution_snapshots: distribution };
      const artifacts: ManagedCaseBackup["artifacts"] = [];
      const missingArtifacts: string[] = [], permittedMissing = abandonedArtifactNames(graph, caseId);
      let total = Buffer.byteLength(JSON.stringify({ graph, references })); archiveCheck(total <= 64 * 1024**2);
      for (const name of managedGraphBlobNames(graph, caseId)) {
        const result = await this.storage.read(caseId, name);
        if (!result) { archiveCheck(permittedMissing.has(name)); missingArtifacts.push(name); continue; }
        total += Math.ceil(result.data.length * 4 / 3); archiveCheck(total <= 250 * 1024**2);
        artifacts.push({ name, bytes: result.metadata.bytes, sha256: result.metadata.sha256, data: result.data.toString("base64") });
        await tx.execute(sql`select 1`);
      }
      const createdAt = new Date().toISOString();
      bytes = Buffer.from(JSON.stringify(canonicalManaged({ schema: 1, backupId, caseId, createdAt, graph, references, artifacts, missingArtifacts })));
      const sha256 = archiveSha(bytes); parseManagedCaseBackup(bytes, sha256, caseId, backupId);
      await tx.insert(B).values({ backupId, caseId, sha256, bytes: bytes.length, status: "prepared", createdAt });
      return { backupId, caseId, sha256, bytes: bytes.length };
    });
    try {
      await this.storage.writeBackup(caseId, backupId, bytes!);
      await this.reconcile(caseId, backupId);
      return { ...reservation, status: "stored" };
    } catch {
      const [observed] = await this.database.select().from(B).where(and(eq(B.caseId, caseId), eq(B.backupId, backupId)));
      if (observed?.status === "stored" && observed.sha256 === reservation.sha256) return { ...reservation, status: "stored" };
      await this.database.update(B).set({ status: "storage_unknown" }).where(and(eq(B.backupId, backupId), eq(B.status, "prepared")));
      throw new ManagedWatchError("outcome_unknown");
    }
  }
  async read(caseId: number, backupId: string) {
    const [row] = await this.database.select().from(B).where(and(eq(B.caseId, caseId), eq(B.backupId, z.uuidv4().parse(backupId))));
    if (!row) throw new ManagedWatchError("not_found");
    const saved = await this.storage.read(caseId, managedBackupName(caseId, backupId)); archiveCheck(saved && saved.data.length === row.bytes);
    return { row, bytes: saved.data, archive: parseManagedCaseBackup(saved.data, row.sha256, caseId, backupId) };
  }
  async reconcile(caseId: number, backupId: string, abandonMissing = false) {
    const [row] = await this.database.select().from(B).where(and(eq(B.caseId, caseId), eq(B.backupId, z.uuidv4().parse(backupId))));
    if (!row || row.status === "abandoned") throw new ManagedWatchError("not_found");
    const saved = await this.storage.read(caseId, managedBackupName(caseId, backupId));
    if (!saved) {
      if (!abandonMissing || row.status === "stored" || Date.now() - Date.parse(row.createdAt) < 10 * 60_000) throw new ManagedWatchError("outcome_unknown");
      await this.database.update(B).set({ status: "abandoned" }).where(and(eq(B.backupId, backupId), eq(B.status, row.status)));
      return { status: "abandoned" };
    }
    archiveCheck(saved.data.length === row.bytes); parseManagedCaseBackup(saved.data, row.sha256, caseId, backupId);
    await this.database.update(B).set({ status: "stored" }).where(and(eq(B.backupId, backupId), eq(B.status, row.status)));
    return { status: "stored", backupId, caseId, sha256: row.sha256, bytes: row.bytes };
  }
}
