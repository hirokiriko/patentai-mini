import { createHash } from "node:crypto";
import type { ContainerClient } from "@azure/storage-blob";
import { isAzureBlobNotFound } from "../azure-blob-errors";
import { managedDigest } from "../patent-watch/managed-claims";
import type { ManagedServiceBudgetStorage } from "../patent-watch/managed-service-budget-storage";
import { requireManual } from "./manual-cli-config";
import { uploadArchiveSchema, uploadFinishedSchema } from "./upload-receipts";
import { KOHO_UPLOAD_CHUNK_BYTES, kohoUploadBlockId, kohoUploadChunkSchema, kohoUploadCreateSchema, kohoUploadPrefix,
  kohoUploadSettingsSchema, kohoUploadStateSchema, type KohoUploadSettings, type KohoUploadState } from "./upload-contract";

export type KohoUploadBudget = Pick<ManagedServiceBudgetStorage, "prepareUpload" | "reserveUpload" | "claimUpload" |
  "beginUploadStaging" | "verifyUploadStaging" | "confirmUpload" | "verifyUpload" | "markUnknown">;
type Saved = { state: KohoUploadState; etag: string };
const MAX_JSON = 512 * 1024;

/** One private, finite upload. Conditional state updates precede writes; reads
 * reconcile lost ACKs without new IDs, a second commit, or another Job start. */
export class KohoUploadStorage {
  readonly settings: KohoUploadSettings;
  private stageDeadline?: AbortSignal;
  constructor(settings: KohoUploadSettings, readonly container: ContainerClient, readonly budget: KohoUploadBudget,
    private readonly deadline: AbortSignal) {
    this.settings = kohoUploadSettingsSchema.parse(settings);
    const b = this.settings.budgetBinding;
    requireManual(container.url === `https://${b.storageAccount}.blob.core.windows.net/${b.container}`);
  }
  private options() {
    this.deadline.throwIfAborted(); this.stageDeadline?.throwIfAborted();
    return { abortSignal: AbortSignal.any([this.deadline, AbortSignal.timeout(20_000), ...(this.stageDeadline ? [this.stageDeadline] : [])]) };
  }
  private async staging(intent: KohoUploadState["intent"]) {
    const permit = await this.budget.verifyUploadStaging(intent);
    requireManual(Number.isFinite(permit.remainingMs) && permit.remainingMs > 0);
    this.stageDeadline = AbortSignal.timeout(Math.floor(permit.remainingMs));
  }
  async assertPrivate() { requireManual(!(await this.container.getProperties(this.options())).blobPublicAccess); }
  private stateBlob(id: string) { return this.container.getBlockBlobClient(kohoUploadPrefix(id) + "state.json"); }
  sourceBlob(id: string) { return this.container.getBlockBlobClient(kohoUploadPrefix(id) + "source.zip"); }
  private async receipt(id: string, name: "finished.json" | "verified-archive.json") {
    const blob = this.container.getBlobClient(kohoUploadPrefix(id) + name), p = await blob.getProperties(this.options());
    requireManual(p.etag && p.contentLength && p.contentLength <= 128 * 1024 && !p.contentEncoding);
    const r = await blob.download(0, p.contentLength, { ...this.options(), conditions: { ifMatch: p.etag }, maxRetryRequests: 0 });
    requireManual(r.etag === p.etag && r.contentLength === p.contentLength && r.readableStreamBody);
    let size = 0; const chunks: Buffer[] = [];
    try { for await (const chunk of r.readableStreamBody!) { const b = Buffer.from(chunk); size += b.length;
      requireManual(size <= p.contentLength!); chunks.push(b); } }
    finally { r.readableStreamBody!.destroy(); }
    requireManual(size === p.contentLength); return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  }
  /** Read-only recovery of a successful DB/receipt ACK even if the final state
   * CAS was lost. Missing or mismatched proof never means a successful import. */
  async reconciled(id: string): Promise<KohoUploadState> {
    const { state: s } = await this.read(id);
    if (!s.startClaimed || s.status === "complete") return s;
    let record: unknown;
    try { record = await this.receipt(id, "finished.json"); }
    catch (e) {
      if (!isAzureBlobNotFound(e)) throw e;
      return Date.now() >= Date.parse(s.intent.expiresAt) && ["submitting", "processing"].includes(s.status) ?
        { ...s, status: "outcome_unknown", error: "outcome_unknown" } : s;
    }
    const f = uploadFinishedSchema.parse(record), a = uploadArchiveSchema.parse(await this.receipt(id, "verified-archive.json"));
    requireManual(s.source && f.operationId === id && a.operationId === id && f.intentDigest === managedDigest(s.intent) &&
      f.archiveDigest === managedDigest(a) && f.sourceSha256 === a.source.sha256 && f.managedReceiptSha256 === a.managedReceiptSha256 &&
      a.source.blobName === kohoUploadPrefix(id) + "source.zip" && a.source.etag === s.source.etag &&
      a.source.byteLength === s.source.byteLength && a.source.blockListDigest === s.source.blockListDigest &&
      a.codeSha === s.intent.settings.codeSha && a.receivedAt === s.intent.receivedAt && a.sourceAcquiredAt === s.intent.sourceAcquiredAt &&
      f.result.documentCount === a.documentCount && f.result.publicationDate === a.publicationDate && f.result.issueNumber === a.issueNumber &&
      f.result.completeClaims + f.result.incompleteClaims === a.documentCount &&
      Date.parse(f.completedAt) >= Date.parse(a.verifiedAt) && Date.parse(a.verifiedAt) >= Date.parse(a.receivedAt));
    const p = await this.sourceBlob(id).getProperties(this.options());
    requireManual(p.etag === s.source!.etag && p.contentLength === s.source!.byteLength && !p.contentEncoding);
    return kohoUploadStateSchema.parse({ ...s, status: "complete", error: null, result: { ...f.result, receiptSha256: managedDigest(f) } });
  }
  async recordExecution(id: string, executionId: string) {
    const s = (await this.read(id)).state;
    requireManual(s.startClaimed && executionId.startsWith(s.intent.settings.job.name + "-") && /^[a-z0-9-]{1,100}$/.test(executionId));
    const bytes = Buffer.from(JSON.stringify({ schema: 1, operationId: id, intentDigest: managedDigest(s.intent), executionId }));
    await this.container.getBlockBlobClient(kohoUploadPrefix(id) + "job-accepted.json").uploadData(bytes, {
      ...this.options(), conditions: { ifNoneMatch: "*" }, maxSingleShotSize: MAX_JSON, concurrency: 1,
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
  }
  async read(id: string): Promise<Saved> {
    await this.assertPrivate();
    const blob = this.stateBlob(id), properties = await blob.getProperties(this.options());
    requireManual(properties.etag && properties.contentLength && properties.contentLength <= MAX_JSON && !properties.contentEncoding);
    const r = await blob.download(0, properties.contentLength, { ...this.options(), conditions: { ifMatch: properties.etag }, maxRetryRequests: 0 });
    requireManual(r.etag === properties.etag && r.contentLength === properties.contentLength && r.readableStreamBody);
    const parts: Buffer[] = []; let bytes = 0;
    try { for await (const chunk of r.readableStreamBody!) { const part = Buffer.from(chunk); bytes += part.length;
      requireManual(bytes <= properties.contentLength!); parts.push(part); } }
    finally { r.readableStreamBody!.destroy(); }
    requireManual(bytes === properties.contentLength);
    const state = kohoUploadStateSchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    requireManual(state.intent.operationId === id && managedDigest(state.intent.settings.budgetBinding) === managedDigest(this.settings.budgetBinding));
    return { state, etag: properties.etag! };
  }
  async replace(saved: Saved, next: KohoUploadState): Promise<Saved> {
    const state = kohoUploadStateSchema.parse(next);
    requireManual(managedDigest(state.intent) === managedDigest(saved.state.intent));
    const bytes = Buffer.from(JSON.stringify(state)); requireManual(bytes.length <= MAX_JSON);
    const result = await this.stateBlob(state.intent.operationId).uploadData(bytes, { ...this.options(), conditions: { ifMatch: saved.etag },
      maxSingleShotSize: MAX_JSON, concurrency: 1, blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
    requireManual(result.etag); return { state, etag: result.etag! };
  }
  async create(value: unknown) {
    const input = kohoUploadCreateSchema.parse(value); requireManual(input.byteLength <= this.settings.maxBytes);
    await this.assertPrivate();
    let previous: Saved | null = null;
    try { previous = await this.read(input.operationId); } catch (e) { if (!isAzureBlobNotFound(e)) throw e; }
    if (previous) {
      requireManual(previous.state.intent.file.fileName === input.fileName && previous.state.intent.file.byteLength === input.byteLength &&
        previous.state.intent.sourceAcquiredAt === input.sourceAcquiredAt && previous.state.intent.receivedAt === input.requestedAt);
      return previous.state;
    }
    const now = Date.parse(input.requestedAt);
    requireManual(now <= Date.now() + 1000 && now > Date.now() - 30 * 60_000);
    const intent = await this.budget.prepareUpload({ schema: 1, settings: this.settings, operationId: input.operationId,
      file: { fileName: input.fileName, byteLength: input.byteLength }, receivedAt: new Date(now).toISOString(), sourceAcquiredAt: input.sourceAcquiredAt,
      expiresAt: new Date(now + 6 * 60 * 60_000).toISOString() });
    await this.budget.reserveUpload(intent); // Same UUID + exact original intent may recover a lost reservation ACK.
    const state = kohoUploadStateSchema.parse({ schema: 1, intent, status: "preparing", chunks: [], pendingChunk: null,
      source: null, sealStarted: false, startClaimed: false, executionId: null, result: null, error: null });
    const bytes = Buffer.from(JSON.stringify(state));
    const result = await this.stateBlob(input.operationId).uploadData(bytes, { ...this.options(), conditions: { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" }, maxSingleShotSize: MAX_JSON, concurrency: 1 });
    requireManual(result.etag);
    await this.budget.beginUploadStaging(intent);
    return (await this.replace({ state, etag: result.etag! }, { ...state, status: "uploading" })).state;
  }
  private async blockPresent(saved: Saved) {
    const s = saved.state, pending = s.pendingChunk; requireManual(pending);
    const response = await this.sourceBlob(s.intent.operationId).getBlockList("all", this.options());
    const blocks = [...(response.uncommittedBlocks ?? []), ...(response.committedBlocks ?? [])];
    requireManual(blocks.length <= 2048);
    return blocks.some(b => b.name === kohoUploadBlockId(pending!.index, pending!.sha256) && b.size === pending!.byteLength);
  }
  async chunk(id: string, index: number, bytes: Buffer) {
    requireManual(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= KOHO_UPLOAD_CHUNK_BYTES);
    bytes = Buffer.from(bytes);
    let saved = await this.read(id); const s = saved.state;
    requireManual(Number.isInteger(index) && index >= 0 && index < Math.ceil(s.intent.file.byteLength / KOHO_UPLOAD_CHUNK_BYTES) &&
      bytes.length === Math.min(KOHO_UPLOAD_CHUNK_BYTES, s.intent.file.byteLength - index * KOHO_UPLOAD_CHUNK_BYTES));
    const chunk = kohoUploadChunkSchema.parse({ index, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    if (index < s.chunks.length) { requireManual(managedDigest(s.chunks[index]) === managedDigest(chunk)); return s; }
    requireManual(s.status === "uploading" && !s.sealStarted && index === s.chunks.length);
    await this.staging(s.intent);
    if (s.pendingChunk) {
      requireManual(managedDigest(s.pendingChunk) === managedDigest(chunk));
      // This request never repeats an uncertain stageBlock.
      requireManual(await this.blockPresent(saved));
    } else {
      saved = await this.replace(saved, { ...s, pendingChunk: chunk });
      await this.sourceBlob(id).stageBlock(kohoUploadBlockId(index, chunk.sha256), bytes, bytes.length, {
        ...this.options(), transactionalContentMD5: createHash("md5").update(bytes).digest() });
    }
    return (await this.replace(saved, { ...saved.state, pendingChunk: null, chunks: [...saved.state.chunks, chunk] })).state;
  }
  async reconcileChunk(id: string) {
    const saved = await this.read(id), s = saved.state;
    if (s.status === "preparing") {
      await this.budget.beginUploadStaging(s.intent);
      return (await this.replace(saved, { ...s, status: "uploading" })).state;
    }
    if (!s.pendingChunk || s.status !== "uploading") return this.reconciled(id);
    await this.staging(s.intent); requireManual(await this.blockPresent(saved));
    return (await this.replace(saved, { ...s, chunks: [...s.chunks, s.pendingChunk], pendingChunk: null })).state;
  }
  async seal(id: string) {
    let saved = await this.read(id), s = saved.state;
    if (s.source) { await this.budget.confirmUpload(s.intent, managedDigest(s.source)); return s; }
    requireManual(s.status === "uploading" && !s.pendingChunk &&
      s.chunks.reduce((n, c) => n + c.byteLength, 0) === s.intent.file.byteLength);
    await this.staging(s.intent);
    const ids = s.chunks.map(c => kohoUploadBlockId(c.index, c.sha256)), blockListDigest = managedDigest(s.chunks);
    if (!s.sealStarted) {
      saved = await this.replace(saved, { ...s, sealStarted: true }); s = saved.state;
      await this.sourceBlob(id).commitBlockList(ids, { ...this.options(), conditions: { ifNoneMatch: "*" },
        metadata: { operation: id, blocks: blockListDigest },
        blobHTTPHeaders: { blobContentType: "application/zip", blobCacheControl: "private, no-store" } });
    }
    // A prior commit intent permits only read-back, including after a lost ACK.
    const p = await this.sourceBlob(id).getProperties(this.options());
    requireManual(p.etag && p.contentLength === s.intent.file.byteLength && p.metadata?.operation === id &&
      p.metadata?.blocks === blockListDigest && p.blobType === "BlockBlob" && !p.contentEncoding);
    const blocks = await this.sourceBlob(id).getBlockList("committed", this.options());
    requireManual(blocks.committedBlocks?.length === ids.length && blocks.committedBlocks.every((b, i) =>
      b.name === ids[i] && b.size === s.chunks[i].byteLength));
    requireManual((await this.sourceBlob(id).getProperties(this.options())).etag === p.etag);
    const source = { etag: p.etag!, byteLength: p.contentLength!, blockListDigest };
    const next = (await this.replace(saved, { ...s, source, status: "uploaded" })).state;
    await this.budget.confirmUpload(s.intent, managedDigest(source));
    return next;
  }
}
