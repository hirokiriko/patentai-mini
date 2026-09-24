import { BlobServiceClient, type ContainerClient, type StoragePipelineOptions, type newPipeline } from "@azure/storage-blob";
import { z } from "zod";
import { managedDigest } from "./managed-claims";
import { MANAGED_SERVICE_KEY, ManagedBudgetError, managedBudgetProfileSchema,
  reserveManagedBudget, claimManagedBudgetPhase, confirmManagedBudgetStage, markManagedBudgetUnknown,
  validateManagedBudgetState,
  type ManagedBudgetClock, type ManagedBudgetState } from "./managed-service-budget";

// The storage binding comes from the installed operator/worker environment, never
// from a request, reporting month, profile revision, or arbitrary Blob name.
const bindingSchema = z.object({ storageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
  container: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/),
  targetBindingHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ManagedBudgetStorageBinding = z.infer<typeof bindingSchema>;
export const MANAGED_BUDGET_PREFIX = `managed-services/${MANAGED_SERVICE_KEY}/`;
const STATE = `${MANAGED_BUDGET_PREFIX}state.json`, MAX_STATE = 16 * 1024 ** 2, IO_MS = 20_000;
const check = (value: unknown) => { if (!value) throw new ManagedBudgetError(); };
const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: IO_MS } };
type ReadState = { state: ManagedBudgetState; etag: string; date: Date };
type Credential = Parameters<typeof newPipeline>[0];

/** One existing private container and one ETag compare-and-swap ledger. No reset,
 * delete, upsert, missing-state initialization, write retry, or caller-selected key. */
export class ManagedServiceBudgetStorage {
  private constructor(private readonly container: ContainerClient, private readonly binding: ManagedBudgetStorageBinding) {
    check(container.url === `https://${binding.storageAccount}.blob.core.windows.net/${binding.container}`);
  }
  static withIdentity(binding: ManagedBudgetStorageBinding, credential: Credential, httpClient?: StoragePipelineOptions["httpClient"]) {
    const b = bindingSchema.parse(binding);
    check(credential);
    // The optional transport is used by real-SDK tests; retry policy stays fixed.
    const service = new BlobServiceClient(`https://${b.storageAccount}.blob.core.windows.net`, credential, { ...options, httpClient });
    return new ManagedServiceBudgetStorage(service.getContainerClient(b.container), b);
  }
  static configured(env: Record<string, string | undefined> = process.env) {
    const b = bindingSchema.parse({ storageAccount: env.MANAGED_BUDGET_STORAGE_ACCOUNT,
      container: env.MANAGED_BUDGET_CONTAINER, targetBindingHash: env.MANAGED_BUDGET_TARGET_SHA256 });
    check(env.AZURE_STORAGE_CONNECTION_STRING);
    const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING!, options);
    return new ManagedServiceBudgetStorage(service.getContainerClient(b.container), b);
  }
  private async readJson(name: string, maximum: number) {
    const signal = AbortSignal.timeout(IO_MS);
    check(!(await this.container.getProperties({ abortSignal: signal })).blobPublicAccess);
    const blob = this.container.getBlobClient(name), p = await blob.getProperties({ abortSignal: signal });
    check(p.etag && p.contentLength && p.contentLength <= maximum && !p.contentEncoding);
    const response = await blob.download(0, p.contentLength, { conditions: { ifMatch: p.etag }, abortSignal: signal, maxRetryRequests: 0 });
    check(response.etag === p.etag && response.contentLength === p.contentLength && response.date instanceof Date &&
      Number.isFinite(response.date.getTime()) && !response.contentEncoding && response.readableStreamBody);
    const stream = response.readableStreamBody!, chunks: Buffer[] = []; let bytes = 0;
    try { for await (const chunk of stream) { const b = Buffer.from(chunk); bytes += b.length; check(bytes <= maximum); chunks.push(b); } }
    finally { stream.destroy(); }
    check(bytes === p.contentLength); signal.throwIfAborted();
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown, etag: p.etag!, date: response.date! };
  }
  private async read(): Promise<ReadState> {
    const saved = await this.readJson(STATE, MAX_STATE), state = validateManagedBudgetState(saved.value, this.binding.targetBindingHash);
    check(state.targetBindingHash === this.binding.targetBindingHash && saved.date.getTime() >= Date.parse(state.lastTrustedAt));
    return { state, etag: saved.etag, date: saved.date };
  }
  private async profile(s: ManagedBudgetState) {
    if (s.activeProfileDigest === null) return null;
    const saved = await this.readJson(`${MANAGED_BUDGET_PREFIX}profiles/${s.activeProfileDigest}.json`, 64 * 1024);
    const p = managedBudgetProfileSchema.parse(saved.value);
    check(managedDigest(p) === s.activeProfileDigest && p.targetBindingHash === this.binding.targetBindingHash);
    return p;
  }
  private clock(saved: ReadState, minutes: number): ManagedBudgetClock {
    // Include bounded metadata/CAS latency and HTTP Date's one-second precision.
    return { blobDate: saved.date, maximumActionMs: minutes * 60_000 + 4 * IO_MS + 1000 };
  }
  private async replace(saved: ReadState, state: ManagedBudgetState) {
    const bytes = Buffer.from(JSON.stringify(validateManagedBudgetState(state, this.binding.targetBindingHash)));
    check(bytes.length <= MAX_STATE && state.targetBindingHash === this.binding.targetBindingHash);
    const result = await this.container.getBlockBlobClient(STATE).uploadData(bytes, { conditions: { ifMatch: saved.etag },
      abortSignal: AbortSignal.timeout(IO_MS), maxSingleShotSize: MAX_STATE, concurrency: 1,
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
    check(result.etag); // An exception, including lost ACK, never grants permission.
  }
  private async guarded<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch { throw new ManagedBudgetError(); }
  }
  async snapshot() { return this.guarded(async () => (await this.read()).state); }
  async reserve(request: unknown) {
    return this.guarded(async () => {
      const saved = await this.read(), p = await this.profile(saved.state);
      const result = reserveManagedBudget(saved.state, request, p, this.clock(saved, 120));
      if (result.created) await this.replace(saved, result.state);
      return { created: result.created }; // A recovered reservation is not a fresh claim.
    });
  }
  async claim(operationId: string, phase: "stage" | "start") {
    return this.guarded(async () => {
      const saved = await this.read(), p = await this.profile(saved.state);
      const state = claimManagedBudgetPhase(saved.state, operationId, phase, p, this.clock(saved, phase === "stage" ? 65 : 120));
      await this.replace(saved, state);
    });
  }
  async confirmStage(operationId: string, requestDigest: string, stageDigest: string) {
    return this.guarded(async () => {
      const saved = await this.read();
      await this.replace(saved, confirmManagedBudgetStage(saved.state, operationId, requestDigest, stageDigest, this.clock(saved, 1)));
    });
  }
  async markUnknown(operationId: string) {
    return this.guarded(async () => {
      const saved = await this.read();
      await this.replace(saved, markManagedBudgetUnknown(saved.state, operationId, this.clock(saved, 1)));
    });
  }
  /** Worker read-back is separate from a new start. An operator's lost ARM ACK
   * must not prevent its already claimed, uniquely bound business worker. The
   * existing DB/receipt execution claim still rejects another worker/restart. */
  async verifyClaimed(operationId: string, requestDigest: string, kind: "watch" | "import") {
    return this.guarded(async () => {
      const saved = await this.read(), o = saved.state.operations.find(o => o.operationId === operationId);
      check(o && o.requestDigest === requestDigest && o.kind === kind && o.start === "claimed" &&
        o.actualYen === null && (o.stage === "unused" || o.stage === "done"));
      const now = saved.date.getTime(), jst = new Date(now + 9 * 60 * 60_000);
      check(o!.processingMonth === jst.toISOString().slice(0, 7));
      const monthEnd = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 60 * 60_000;
      const deadline = Math.min(monthEnd, Date.parse(o!.expiresAt));
      check(now + this.clock(saved, kind === "watch" ? 95 : 120).maximumActionMs < deadline);
      if (o!.scope === "standard") { const p = await this.profile(saved.state); check(p && managedDigest(p) === o!.profileDigest); }
      return { processingMonth: o!.processingMonth, expiresAt: new Date(deadline).toISOString() };
    });
  }
}
