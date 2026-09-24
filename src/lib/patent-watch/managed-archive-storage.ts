import { createHash } from "node:crypto";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { z } from "zod";
import { isScopedOriginalName } from "../blob-storage";
import { managedArtifactName, validateManagedArtifactManifest } from "./managed-storage";
import { managedId, ManagedWatchError } from "./managed-types";
import { archiveCheck, type CaseGraph } from "../../repositories/managed-case-graph";
import { parseUploadedOriginalFileMetadata } from "../original-file-metadata";

export const archiveSha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const managedBackupName = (caseId: number, id: string) => `cases/${managedId.parse(caseId)}/managed-backups/${z.uuidv4().parse(id)}.json`;
export type ArchiveBlob = { name: string; bytes: number; sha256: string; etag: string };
export function validManagedCaseBlob(name: string, caseId: number) {
  if (isScopedOriginalName(name, caseId, "drafts") || isScopedOriginalName(name, caseId, "prior-art")) return true;
  const prefix = `cases/${managedId.parse(caseId)}/`, tail = name.startsWith(prefix) ? name.slice(prefix.length) : "";
  return /^managed-backups\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/.test(tail) ||
    /^managed-deliveries\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:snapshot\.json|pdf\.pdf|csv\.csv)$/.test(tail);
}
export function managedGraphBlobNames(graph: CaseGraph, caseId: number): string[] {
  const names = new Set<string>();
  for (const row of graph.draft_patents) {
    if (typeof row.source_file_path === "string" && row.source_file_path.startsWith("cases/")) names.add(row.source_file_path);
  }
  for (const row of graph.prior_art_documents) {
    const metadata = parseUploadedOriginalFileMetadata(row.source_csv_row_json as string | null);
    if (metadata) names.add(metadata.blobName);
  }
  for (const row of graph.managed_watch_deliveries) if (row.blob_manifest_json) {
    const manifest = validateManagedArtifactManifest(JSON.parse(row.blob_manifest_json as string), caseId, row.delivery_id as string);
    for (const artifact of manifest.artifacts) names.add(managedArtifactName(caseId, manifest.deliveryId, artifact.kind));
  }
  archiveCheck(names.size <= 256 && [...names].every(name => validManagedCaseBlob(name, caseId)));
  return [...names].sort();
}
export class ManagedArchiveStorage {
  constructor(private readonly container: ContainerClient, private readonly deadline?: AbortSignal) {}
  get location() { return this.container.url; }
  withDeadline(deadline: AbortSignal) { return new ManagedArchiveStorage(this.container, this.deadline ? AbortSignal.any([this.deadline, deadline]) : deadline); }
  private signal(milliseconds = 20_000) { return this.deadline ? AbortSignal.any([this.deadline, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds); }
  static configured() {
    const connection = process.env.AZURE_STORAGE_CONNECTION_STRING, name = process.env.AZURE_BLOB_CONTAINER_NAME;
    if (!connection || !name) throw new ManagedWatchError("unavailable");
    return new ManagedArchiveStorage(BlobServiceClient.fromConnectionString(connection, { retryOptions: { maxTries: 1, tryTimeoutInMs: 20_000 } }).getContainerClient(name));
  }
  private async privateContainer() {
    this.deadline?.throwIfAborted();
    if ((await this.container.getProperties({ abortSignal: this.signal() })).blobPublicAccess) throw new ManagedWatchError("unavailable");
  }
  async list(caseId: number): Promise<string[]> {
    try {
      await this.privateContainer(); const names: string[] = [];
      for await (const page of this.container.listBlobsFlat({ prefix: `cases/${managedId.parse(caseId)}/`, abortSignal: this.signal() }).byPage({ maxPageSize: 257 })) {
        for (const item of page.segment.blobItems) names.push(item.name);
        archiveCheck(names.length <= 256 && names.every(name => validManagedCaseBlob(name, caseId)));
      }
      return names.sort();
    } catch { throw new ManagedWatchError("unavailable"); }
  }
  async read(caseId: number, name: string): Promise<{ metadata: ArchiveBlob; data: Buffer } | null> {
    archiveCheck(validManagedCaseBlob(name, caseId));
    try {
      await this.privateContainer(); const blob = this.container.getBlobClient(name);
      const p = await blob.getProperties({ abortSignal: this.signal() });
      const max = name.includes("/managed-backups/") ? 256 * 1024**2 : 50 * 1024**2;
      archiveCheck(p.etag && Number.isSafeInteger(p.contentLength) && p.contentLength! >= 0 && p.contentLength! <= max);
      const data = p.contentLength === 0 ? Buffer.alloc(0) : await blob.downloadToBuffer(0, p.contentLength, { conditions: { ifMatch: p.etag }, abortSignal: this.signal() });
      archiveCheck(data.length === p.contentLength);
      return { metadata: { name, bytes: data.length, sha256: archiveSha(data), etag: p.etag! }, data };
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error && error.statusCode === 404 && "code" in error && error.code === "BlobNotFound") return null;
      throw new ManagedWatchError("unavailable");
    }
  }
  async writeBackup(caseId: number, id: string, bytes: Buffer) {
    archiveCheck(bytes.length > 0 && bytes.length <= 256 * 1024**2);
    try {
      await this.privateContainer();
      await this.container.getBlockBlobClient(managedBackupName(caseId, id)).uploadData(bytes, { conditions: { ifNoneMatch: "*" }, abortSignal: this.signal(30_000),
        blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
    } catch { throw new ManagedWatchError("outcome_unknown"); }
  }
  async remove(caseId: number, entry: ArchiveBlob) {
    const current = await this.read(caseId, entry.name);
    if (!current) return;
    archiveCheck(current.metadata.sha256 === entry.sha256 && current.metadata.bytes === entry.bytes && current.metadata.etag === entry.etag);
    try {
      // Retained versions/soft-delete are separately reported by the operator preflight.
      await this.container.getBlobClient(entry.name).delete({ conditions: { ifMatch: entry.etag }, deleteSnapshots: "include", abortSignal: this.signal() });
    } catch { throw new ManagedWatchError("outcome_unknown"); }
    archiveCheck(await this.read(caseId, entry.name) === null);
  }
}
