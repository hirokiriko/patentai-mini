import { BlobServiceClient, type ContainerClient, type StoragePipelineOptions, type newPipeline } from "@azure/storage-blob";
import { createHash } from "node:crypto";
import { z } from "zod";
import { managedDigest } from "./managed-claims";
import { MANAGED_SERVICE_KEY, ManagedBudgetError, managedBudgetProfileSchema,
  reserveManagedBudget, claimManagedBudgetPhase, confirmManagedBudgetStage, markManagedBudgetUnknown,
  validateManagedBudgetState, settleManagedBudget, setManagedMonthPlan, activateManagedBudgetProfile,
  type ManagedBudgetClock, type ManagedBudgetState } from "./managed-service-budget";
import { verifyManagedSettlementReview, verifyManagedAdministrationReview, managedSettlementProof, managedReleaseBudgetRequest, type ManagedBudgetEvidencePins } from "./managed-budget-evidence";
import { managedBudgetBindingSchema, managedBudgetBindingFromEnvironment } from "./managed-budget-contract";
import { validateManagedBudgetPolicy } from "./managed-budget-policy";
import { managedWatchBudgetRequest, managedImportBudgetRequest, managedArtifactBudgetRequest, type ManagedImportJob } from "./managed-execution-budget";
import { managedArtifactIntentSchema, managedArtifactContextSchema } from "./managed-artifact-contract";
import { parseManagedCloudConfiguration, parseManagedCloudStartConfiguration } from "./managed-cloud-config";
import { parseCloudConfiguration, parseManagedCloudImportConfiguration, isManagedCloudConfiguration } from "../koho-import/cloud-config";

// The storage binding comes from the installed operator/worker environment, never
// from a request, reporting month, profile revision, or arbitrary Blob name.
const bindingSchema = managedBudgetBindingSchema;
export type ManagedBudgetStorageBinding = z.infer<typeof bindingSchema>;
export const MANAGED_BUDGET_PREFIX = `managed-services/${MANAGED_SERVICE_KEY}/`;
const STATE = `${MANAGED_BUDGET_PREFIX}state.json`, MAX_STATE = 16 * 1024 ** 2, IO_MS = 20_000;
const OPENING_INTENT = `${MANAGED_BUDGET_PREFIX}opening-intent.json`, OPENED = `${MANAGED_BUDGET_PREFIX}opened.json`;
const openingRecordSchema = z.object({ schema: z.literal(1), reviewDigest: z.string().regex(/^[a-f0-9]{64}$/),
  initialStateDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const check = (value: unknown) => { if (!value) throw new ManagedBudgetError(); };
const options = { retryOptions: { maxTries: 1, tryTimeoutInMs: IO_MS } };
const missingBlob = (e: unknown) => e && typeof e === "object" && "statusCode" in e && e.statusCode === 404 &&
  "code" in e && e.code === "BlobNotFound";
type ReadState = { state: ManagedBudgetState; etag: string; date: Date };
type Credential = Parameters<typeof newPipeline>[0];

/** One existing private container and one ETag compare-and-swap ledger. No reset,
 * delete, upsert, automatic initialization, write retry, or caller-selected key. */
export class ManagedServiceBudgetStorage {
  private constructor(private readonly container: ContainerClient, private readonly binding: ManagedBudgetStorageBinding, private readonly deadline?: AbortSignal) {
    check(container.url === `https://${binding.storageAccount}.blob.core.windows.net/${binding.container}`);
  }
  withDeadline(deadline: AbortSignal) {
    return new ManagedServiceBudgetStorage(this.container, this.binding, this.deadline ? AbortSignal.any([this.deadline, deadline]) : deadline);
  }
  private signal() { return this.deadline ? AbortSignal.any([this.deadline, AbortSignal.timeout(IO_MS)]) : AbortSignal.timeout(IO_MS); }
  static withIdentity(binding: ManagedBudgetStorageBinding, credential: Credential, httpClient?: StoragePipelineOptions["httpClient"]) {
    const b = bindingSchema.parse(binding);
    check(credential);
    // The optional transport is used by real-SDK tests; retry policy stays fixed.
    const service = new BlobServiceClient(`https://${b.storageAccount}.blob.core.windows.net`, credential, { ...options, httpClient });
    return new ManagedServiceBudgetStorage(service.getContainerClient(b.container), b);
  }
  static configured(env: Record<string, string | undefined> = process.env) {
    const b = managedBudgetBindingFromEnvironment(env);
    check(env.AZURE_STORAGE_CONNECTION_STRING);
    const service = BlobServiceClient.fromConnectionString(env.AZURE_STORAGE_CONNECTION_STRING!, options);
    return new ManagedServiceBudgetStorage(service.getContainerClient(b.container), b);
  }
  private async readJson(name: string, maximum: number) {
    const signal = this.signal(); signal.throwIfAborted();
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
    const body = Buffer.concat(chunks);
    return { value: JSON.parse(body.toString("utf8")) as unknown, etag: p.etag!, date: response.date!,
      bytes, sha256: createHash("sha256").update(body).digest("hex"), createdAt: p.createdOn };
  }
  private async read(requireOpening = true): Promise<ReadState> {
    const saved = await this.readJson(STATE, MAX_STATE), state = validateManagedBudgetState(saved.value, this.binding.targetBindingHash);
    check(state.targetBindingHash === this.binding.targetBindingHash && state.administration.length > 0 &&
      saved.date.getTime() >= Date.parse(state.lastTrustedAt));
    if (requireOpening) {
      const record = openingRecordSchema.parse((await this.readJson(OPENED, 4096)).value);
      check(record.reviewDigest === state.administration[0].digest);
    }
    return { state, etag: saved.etag, date: saved.date };
  }
  private async profile(s: ManagedBudgetState, digest = s.activeProfileDigest) {
    if (digest === null) return null;
    const saved = await this.readJson(`${MANAGED_BUDGET_PREFIX}profiles/${digest}.json`, 64 * 1024);
    const p = managedBudgetProfileSchema.parse(saved.value);
    check(managedDigest(p) === digest && p.targetBindingHash === this.binding.targetBindingHash && p.ownerBindingHash === this.binding.ownerBindingHash);
    return p;
  }
  private async executionPolicy(saved: ReadState, digest: string, minutes: number) {
    check(/^[a-f0-9]{64}$/.test(digest));
    const source = await this.readJson(`${MANAGED_BUDGET_PREFIX}evidence/${digest}.json`, 128 * 1024);
    check(source.sha256 === digest);
    return validateManagedBudgetPolicy(source.value, this.binding, saved.date, this.clock(saved, minutes).maximumActionMs);
  }
  private currentPricing(saved: ReadState) {
    const month = new Date(saved.date.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 7);
    const plan = saved.state.plans.find(p => p.month === month); check(plan); return plan!.pricingDigest;
  }
  private async watchRequest(value: unknown, saved: ReadState, worker = false) {
    const c = parseManagedCloudConfiguration(value, saved.date.getTime(), !worker);
    const op = worker ? saved.state.operations.find(o => o.operationId === c.operationId) : undefined;
    if (worker) check(op);
    const pricingDigest = worker ? op!.pricingDigest : this.currentPricing(saved);
    const profileDigest = worker ? op!.profileDigest : c.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1" ? saved.state.activeProfileDigest : null;
    const p = await this.executionPolicy(saved, pricingDigest, worker ? 95 : 120);
    const business = { ...c, expectedEnvironmentResourceId:c.expectedEnvironmentResourceId ?? p.targets.environmentResourceId };
    const request = managedWatchBudgetRequest(business, p, this.binding, pricingDigest, profileDigest);
    const serviceBudget = { serviceKey: MANAGED_SERVICE_KEY, requestDigest: request.requestDigest, profileDigest, pricingDigest };
    if (c.budgetBinding) check(managedDigest(c.budgetBinding) === managedDigest(this.binding));
    if (c.serviceBudget) check(managedDigest(c.serviceBudget) === managedDigest(serviceBudget));
    const profile = await this.executionProfile(saved, profileDigest, p);
    return { config: parseManagedCloudStartConfiguration({ ...business, serviceBudget, budgetBinding: this.binding }, saved.date.getTime(), !worker), request, policy: p, profile, executionExpiresAt:c.expiresAt };
  }
  private async importRequest(value: unknown, manifest: unknown, job: ManagedImportJob, saved: ReadState, worker = false) {
    const c = parseCloudConfiguration(value); check(isManagedCloudConfiguration(c));
    if (!isManagedCloudConfiguration(c)) throw new ManagedBudgetError();
    const op = worker ? saved.state.operations.find(o => o.operationId === c.operationId) : undefined;
    if (worker) check(op);
    const pricingDigest = worker ? op!.pricingDigest : this.currentPricing(saved);
    const profileDigest = worker ? op!.profileDigest : c.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1" ? saved.state.activeProfileDigest : null;
    const p = await this.executionPolicy(saved, pricingDigest, 120);
    const request = managedImportBudgetRequest(c, manifest, job, p, this.binding, pricingDigest, profileDigest);
    const serviceBudget = { serviceKey: MANAGED_SERVICE_KEY, requestDigest: request.requestDigest, profileDigest, pricingDigest };
    if (c.budgetBinding) check(managedDigest(c.budgetBinding) === managedDigest(this.binding));
    if (c.serviceBudget) check(managedDigest(c.serviceBudget) === managedDigest(serviceBudget));
    const profile = await this.executionProfile(saved, profileDigest, p);
    return { config: parseManagedCloudImportConfiguration({ ...c, serviceBudget, budgetBinding: this.binding }), request, policy: p, profile,
      executionExpiresAt:(manifest as {expiresAt:string}).expiresAt };
  }
  private async executionProfile(saved: ReadState, digest: string | null, policy: Awaited<ReturnType<ManagedServiceBudgetStorage["executionPolicy"]>>) {
    const p = await this.profile(saved.state, digest);
    if (p) check(p.measurementDigest === policy.measurementDigest);
    return p;
  }
  /** Reserve and claim commit atomically. An interrupted attempt keeps both
   * records; only a fresh CAS ACK grants execution, never a recovered record. */
  async admitArtifact(value: unknown, installedContext: unknown) {
    return this.guarded(async () => {
      check(this.deadline); this.deadline!.throwIfAborted();
      const intent = managedArtifactIntentSchema.parse(value), context = managedArtifactContextSchema.parse(installedContext);
      const minutes = intent.kind === "delivery" ? 1.5 : 5;
      const saved = await this.read(), pricingDigest = this.currentPricing(saved);
      const profileDigest = context.approval === "STANDARD_MANAGED_WATCH_STANDARD_V1" ? saved.state.activeProfileDigest : null;
      const policy = await this.executionPolicy(saved, pricingDigest, minutes), profile = await this.executionProfile(saved, profileDigest, policy);
      const request = managedArtifactBudgetRequest(intent, context, policy, this.binding, pricingDigest, profileDigest);
      const fresh = await this.read(); check(fresh.etag === saved.etag);
      validateManagedBudgetPolicy(policy, this.binding, fresh.date, this.clock(fresh, minutes).maximumActionMs);
      const reserved = reserveManagedBudget(fresh.state, request, profile, this.clock(fresh, minutes));
      check(reserved.created);
      await this.replace(fresh, claimManagedBudgetPhase(reserved.state, request.operationId, "start", profile, this.clock(fresh, minutes)));
      this.deadline!.throwIfAborted();
    });
  }
  private async commitExecution(saved: ReadState, context: Awaited<ReturnType<ManagedServiceBudgetStorage["watchRequest"]>> |
    Awaited<ReturnType<ManagedServiceBudgetStorage["importRequest"]>>, phase?: "stage" | "start") {
    const fresh = await this.read(); check(fresh.etag === saved.etag);
    // In addition to bounded Blob IO, a start retains a minute for the marker
    // and ARM request. Worker admission rechecks any subsequent scheduling delay.
    const minutes = phase === "stage" ? 65 : phase === "start" ? (context.request.kind === "watch" ? 96 : 121) : 120;
    check(fresh.date.getTime() + this.clock(fresh, minutes).maximumActionMs < Date.parse(context.executionExpiresAt));
    validateManagedBudgetPolicy(context.policy, this.binding, fresh.date, this.clock(fresh, minutes).maximumActionMs);
    if (phase) {
      const o = fresh.state.operations.find(o => o.operationId === context.request.operationId);
      check(o?.intentDigest === managedDigest({ ...context.request, cases: [...context.request.cases].sort((a,b) => a-b) }));
      await this.replace(fresh, claimManagedBudgetPhase(fresh.state, context.request.operationId, phase, context.profile, this.clock(fresh, minutes)));
      return { created: false };
    }
    const result = reserveManagedBudget(fresh.state, context.request, context.profile, this.clock(fresh, minutes));
    if (result.created) await this.replace(fresh, result.state);
    return { created: result.created };
  }
  /** Preparation is read-only. Only the installed binding and a reviewed current
   * plan can select prices and the active Standard profile. */
  async prepareWatch(value: unknown) { return this.guarded(async () => {
    const c = parseManagedCloudConfiguration(value); return (await this.watchRequest(c, await this.read())).config;
  }); }
  async prepareImport(value: unknown, manifest: unknown, job: ManagedImportJob) {
    return this.guarded(async () => {
      const c = parseCloudConfiguration(value), m: unknown = structuredClone(manifest), j = structuredClone(job);
      return (await this.importRequest(c, m, j, await this.read())).config;
    });
  }
  async reserveWatch(value: unknown) {
    return this.guarded(async () => {
      const c = parseManagedCloudStartConfiguration(value), saved = await this.read();
      return this.commitExecution(saved, await this.watchRequest(c, saved));
    });
  }
  async reserveImport(value: unknown, manifest: unknown, job: ManagedImportJob) {
    return this.guarded(async () => {
      const c = parseManagedCloudImportConfiguration(value), m: unknown = structuredClone(manifest), j = structuredClone(job), saved = await this.read();
      return this.commitExecution(saved, await this.importRequest(c, m, j, saved));
    });
  }
  async claimWatch(value: unknown) {
    return this.guarded(async () => {
      const c = parseManagedCloudStartConfiguration(value), saved = await this.read();
      await this.commitExecution(saved, await this.watchRequest(c, saved), "start");
    });
  }
  async claimImport(value: unknown, manifest: unknown, job: ManagedImportJob, phase: "stage" | "start") {
    return this.guarded(async () => {
      const c = parseManagedCloudImportConfiguration(value), m: unknown = structuredClone(manifest), j = structuredClone(job), saved = await this.read();
      await this.commitExecution(saved, await this.importRequest(c, m, j, saved), phase);
    });
  }
  async confirmImport(value: unknown, manifest: unknown, job: ManagedImportJob) {
    return this.guarded(async () => {
      const c = parseManagedCloudImportConfiguration(value), m: unknown = structuredClone(manifest), j = structuredClone(job), saved = await this.read();
      const context = await this.importRequest(c, m, j, saved), fresh = await this.read(); check(fresh.etag === saved.etag);
      const o = fresh.state.operations.find(o => o.operationId === c.operationId);
      check(o?.intentDigest === managedDigest(context.request));
      if (o!.stage === "done") { check(o!.evidenceDigests.includes(c.manifest.sha256)); return; }
      await this.replace(fresh, confirmManagedBudgetStage(fresh.state, c.operationId, context.request.requestDigest, c.manifest.sha256, this.clock(fresh, 1)));
    });
  }
  async verifyWatch(value: unknown) {
    return this.guarded(async () => {
      const c = parseManagedCloudStartConfiguration(value, Date.now(), false), saved = await this.read();
      return this.verifyExecution(await this.watchRequest(c, saved, true), c.expiresAt);
    });
  }
  async verifyImport(value: unknown, manifest: unknown, job: ManagedImportJob) {
    return this.guarded(async () => {
      const c = parseManagedCloudImportConfiguration(value), m: unknown = structuredClone(manifest), j = structuredClone(job), saved = await this.read();
      // The intent builder validates the manifest schema and fixed target first.
      return this.verifyExecution(await this.importRequest(c, m, j, saved, true), (m as { expiresAt: string }).expiresAt);
    });
  }
  private async verifyExecution(context: Awaited<ReturnType<ManagedServiceBudgetStorage["watchRequest"]>> |
    Awaited<ReturnType<ManagedServiceBudgetStorage["importRequest"]>>, executionExpiresAt: string) {
    const saved = await this.read(), r = context.request, o = saved.state.operations.find(o => o.operationId === r.operationId);
    check(o && o.intentDigest === managedDigest({ ...r, cases: [...r.cases].sort((a,b) => a-b) }) &&
      o.start === "claimed" && o.actualYen === null && (o.kind === "watch" ? o.stage === "unused" : o.stage === "done"));
    const now = saved.date.getTime(), month = new Date(now + 9 * 60 * 60_000).toISOString().slice(0,7);
    const maximumActionMs = this.clock(saved, o!.kind === "watch" ? 95 : 120).maximumActionMs;
    const policy = validateManagedBudgetPolicy(context.policy, this.binding, saved.date, maximumActionMs);
    const expiry = Math.min(Date.parse(o!.expiresAt), Date.parse(executionExpiresAt), Date.parse(policy.validUntil));
    check(o!.processingMonth === month && now + maximumActionMs < expiry);
    if (context.profile) check(context.profile.pricingDigest === o!.pricingDigest && o!.cases.every(id => context.profile!.cases.includes(id)));
    return { processingMonth: month, expiresAt: new Date(expiry).toISOString(), remainingMs: expiry - now - 4 * IO_MS - 1000 };
  }
  private clock(saved: ReadState, minutes: number): ManagedBudgetClock {
    // Include bounded metadata/CAS latency and HTTP Date's one-second precision.
    return { blobDate: saved.date, maximumActionMs: minutes * 60_000 + 4 * IO_MS + 1000 };
  }
  private async replace(saved: ReadState, state: ManagedBudgetState) {
    this.deadline?.throwIfAborted();
    const bytes = Buffer.from(JSON.stringify(validateManagedBudgetState(state, this.binding.targetBindingHash)));
    check(bytes.length <= MAX_STATE && state.targetBindingHash === this.binding.targetBindingHash);
    const result = await this.container.getBlockBlobClient(STATE).uploadData(bytes, { conditions: { ifMatch: saved.etag },
      abortSignal: this.signal(), maxSingleShotSize: MAX_STATE, concurrency: 1,
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
    check(result.etag); // An exception, including lost ACK, never grants permission.
    this.deadline?.throwIfAborted();
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
  private async verifySources(sources: Array<{ digest: string; bytes: number }>) {
    for (const entry of sources) {
      const actual = await this.readJson(`${MANAGED_BUDGET_PREFIX}evidence/${entry.digest}.json`, 128 * 1024);
      check(actual.bytes === entry.bytes && actual.sha256 === entry.digest);
    }
  }
  private async createJson(name: string, value: unknown, maximum: number) {
    const bytes = Buffer.from(JSON.stringify(value)); check(bytes.length <= maximum);
    const result = await this.container.getBlockBlobClient(name).uploadData(bytes, { conditions: { ifNoneMatch: "*" },
      abortSignal: this.signal(), maxSingleShotSize: maximum, concurrency: 1,
      blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
    check(result.etag);
  }
  private async openReviewed(envelope: ReturnType<typeof verifyManagedAdministrationReview>, evidenceDigest: string,
    pins: ManagedBudgetEvidencePins, reconcileOnly: boolean) {
    const r = envelope.review; if (r.action.kind !== "open") throw new ManagedBudgetError();
    const initial = validateManagedBudgetState(r.action.state, this.binding.targetBindingHash);
    initial.administration.push({ sequence: 1, digest: evidenceDigest });
    const state = validateManagedBudgetState(initial, this.binding.targetBindingHash);
    const expected = { schema: 1 as const, reviewDigest: evidenceDigest, initialStateDigest: managedDigest(state) };
    const record = async (name: string) => {
      try { const saved = await this.readJson(name, 4096);
        check(managedDigest(openingRecordSchema.parse(saved.value)) === managedDigest(expected)); return saved; }
      catch (e) { if (missingBlob(e)) return null; throw e; }
    };
    const opened = await record(OPENED);
    if (opened) {
      // Losing the ledger after opening is a restore incident, never another
      // chance to apply the old opening snapshot and erase accumulated usage.
      const saved = await this.read(); check(saved.state.administration[0].digest === evidenceDigest);
      return { status: "already_applied" as const };
    }
    const intent = await record(OPENING_INTENT);
    let saved: ReadState | null;
    try { saved = await this.read(false); } catch (e) { if (missingBlob(e)) saved = null; else throw e; }
    if (saved) check(intent && managedDigest(saved.state) === expected.initialStateDigest);
    if (intent) {
      check(intent.createdAt instanceof Date && intent.createdAt.getTime() <= intent.date.getTime());
      verifyManagedAdministrationReview(envelope, evidenceDigest, pins, intent.createdAt!);
    }
    if (reconcileOnly) return { status: intent ? "pending" as const : "not_applied" as const };
    await this.verifySources(r.sources);
    const date = (await this.readJson(`${MANAGED_BUDGET_PREFIX}administration-reviews/${evidenceDigest}.json`, 128 * 1024)).date;
    check(Date.parse(state.lastTrustedAt) <= date.getTime());
    if (!intent) {
      verifyManagedAdministrationReview(envelope, evidenceDigest, pins, date);
      check(date.getTime() + 2 * IO_MS + 1000 < Date.parse(r.validUntil));
      await this.createJson(OPENING_INTENT, expected, 4096);
    }
    if (!saved) await this.createJson(STATE, state, MAX_STATE);
    // No business read/claim is admitted until this separate create-only marker
    // exists. Therefore an interrupted opening can only contain its exact snapshot.
    await this.createJson(OPENED, expected, 4096);
    return { status: "applied" as const };
  }
  /** Local administration only. A separately signed exact-state review is the
   * authority, not stdin amounts, a business profile, or a missing-state default.
   * CAS is the sole admin commit: a conflict needs a new review of current state,
   * while a lost ACK is resolved from its permanently retained sequence/digest. */
  async applyReviewedAdministration(evidenceDigest: string, pins: ManagedBudgetEvidencePins, reconcileOnly = false) {
    return this.guarded(async () => {
      check(/^[a-f0-9]{64}$/.test(evidenceDigest) && pins.targetBindingHash === this.binding.targetBindingHash && pins.ownerBindingHash === this.binding.ownerBindingHash);
      const name = `${MANAGED_BUDGET_PREFIX}administration-reviews/${evidenceDigest}.json`;
      const source = await this.readJson(name, 128 * 1024);
      const envelope = verifyManagedAdministrationReview(source.value, evidenceDigest, pins, source.date, false), r = envelope.review;
      if (r.action.kind === "open") return this.openReviewed(envelope, evidenceDigest, pins, reconcileOnly);
      const readOptional = async () => { try { return await this.read(); } catch (e) { if (missingBlob(e)) return null; throw e; } };
      const applied = (saved: ReadState | null) => {
        const previous = saved?.state.administration.find(p => p.digest === evidenceDigest);
        if (previous) check(previous.sequence === r.sequence);
        return !!previous;
      };
      let saved = await readOptional();
      if (applied(saved)) return { status: "already_applied" as const };
      const matches = (value: ReadState | null) => !!value &&
        managedDigest(value.state) === r.expectedStateDigest && r.sequence === value.state.administration.length + 1 &&
        r.previousReviewDigest === (value.state.administration.at(-1)?.digest ?? null);
      if (reconcileOnly) return { status: matches(saved) ? "not_applied" as const : "review_stale" as const };
      check(matches(saved)); await this.verifySources(r.sources);
      const releasePolicy = r.action.kind === "release-start" ? await this.executionPolicy(saved!, r.action.step.pricingDigest, 90) : undefined;
      let p: z.infer<typeof managedBudgetProfileSchema> | undefined;
      if (r.action.kind === "activate") {
        p = managedBudgetProfileSchema.parse((await this.readJson(`${MANAGED_BUDGET_PREFIX}profiles/${r.action.profileDigest}.json`, 64 * 1024)).value);
        check(managedDigest(p) === r.action.profileDigest && p.ownerBindingHash === pins.ownerBindingHash);
      }
      saved = await readOptional();
      if (applied(saved)) return { status: "already_applied" as const };
      check(matches(saved));
      const date = saved!.date;
      verifyManagedAdministrationReview(envelope, evidenceDigest, pins, date);
      check(date.getTime() + 3 * IO_MS + 1000 < Date.parse(r.validUntil));
      const clock = { blobDate: date, maximumActionMs: 3 * IO_MS + 1000 };
      let state: ManagedBudgetState;
      if (r.action.kind === "month") {
        const month = new Date(date.getTime() + 9 * 60 * 60_000).toISOString().slice(0, 7);
        check(r.action.processingMonth === month);
        state = setManagedMonthPlan(saved!.state, { ...r.action, evidenceDigest }, clock);
      } else if (r.action.kind === "activate") state = activateManagedBudgetProfile(saved!.state, p, r.action, clock);
      else {
        // Local preflight binds the exact operation/refs and all CI/deploy
        // triggers. The existing connector/CLI is invoked once only after this
        // fresh ACK; reconciliation must never recreate an execution permit.
        const request = managedReleaseBudgetRequest(r.action.step, pins.targetBindingHash, pins.ownerBindingHash);
        const executionClock = this.clock(saved!, 90);
        validateManagedBudgetPolicy(releasePolicy, this.binding, date, executionClock.maximumActionMs);
        const reserved = reserveManagedBudget(saved!.state, request, null, executionClock); check(reserved.created);
        state = claimManagedBudgetPhase(reserved.state, request.operationId, "start", null, executionClock);
      }
      state.administration.push({ sequence: r.sequence, digest: evidenceDigest });
      state = validateManagedBudgetState(state, this.binding.targetBindingHash);
      await this.replace(saved!, state);
      if (r.action.kind === "release-start") return { status: "admitted" as const, operationId: r.action.step.operationId,
        trigger: r.action.step.trigger, repository: r.action.step.repository, targetRef: r.action.step.targetRef,
        headSha: r.action.step.headSha, baseSha: r.action.step.baseSha, treeSha: r.action.step.treeSha,
        remoteBeforeSha: r.action.step.remoteBeforeSha, prNumber: r.action.step.prNumber,
        executeBefore: new Date(Math.min(date.getTime() + 60_000, Date.parse(r.validUntil))).toISOString() };
      return { status: "applied" as const };
    });
  }
  /** Only the separate administration CLI supplies the installed verification
   * pins. Input selects a signed review by digest, never an amount or usage DTO. */
  async settleReviewed(evidenceDigest: string, pins: ManagedBudgetEvidencePins, reconcileOnly = false) {
    return this.guarded(async () => {
      check(/^[a-f0-9]{64}$/.test(evidenceDigest) && pins.targetBindingHash === this.binding.targetBindingHash && pins.ownerBindingHash === this.binding.ownerBindingHash);
      const source = await this.readJson(`${MANAGED_BUDGET_PREFIX}settlement-reviews/${evidenceDigest}.json`, 128 * 1024);
      const envelope = verifyManagedSettlementReview(source.value, evidenceDigest, pins, source.date, false), r = envelope.review;
      const slotName = `${MANAGED_BUDGET_PREFIX}settlements/${r.operationId}/${r.sequence}.json`;
      let slot: Awaited<ReturnType<ManagedServiceBudgetStorage["readJson"]>> | null;
      try { slot = await this.readJson(slotName, 128 * 1024); }
      catch (error) {
        if (missingBlob(error)) slot = null;
        else throw error;
      }
      if (slot) {
        check(managedDigest(slot.value) === evidenceDigest && slot.createdAt instanceof Date && slot.createdAt.getTime() <= slot.date.getTime());
        // A proof registered while its signature was valid remains recoverable
        // after a lost ACK/ETag conflict. Last-Modified is not creation evidence.
        verifyManagedSettlementReview(envelope, evidenceDigest, pins, slot.createdAt!);
      }
      let saved = await this.read();
      const operation = () => { const o = saved.state.operations.find(o => o.operationId === r.operationId);
        check(o && o.requestDigest === r.requestDigest && o.pricingDigest === r.pricingDigest); return o!; };
      let o = operation();
      if (r.sequence <= o.lastProofSequence) {
        check(slot);
        const recent = o.settlements.find(p => p.sequence === r.sequence);
        if (recent) { check(recent.evidenceDigest === evidenceDigest);
          settleManagedBudget(saved.state, managedSettlementProof(r, evidenceDigest), this.clock(saved, 1)); }
        return { status: "already_applied" as const };
      }
      check(r.sequence === o.lastProofSequence + 1 && r.previousProofDigest === (o.settlements.at(-1)?.evidenceDigest ?? null));
      if (reconcileOnly) return { status: slot ? "pending" as const : "not_staged" as const };
      await this.verifySources(r.sources);
      // Read the real clock/state again after bounded evidence IO. This also
      // detects a competing settlement before creating its immutable slot.
      saved = await this.read(); o = operation();
      check(r.sequence === o.lastProofSequence + 1 && r.previousProofDigest === (o.settlements.at(-1)?.evidenceDigest ?? null));
      verifyManagedSettlementReview(envelope, evidenceDigest, pins, saved.date, !slot);
      if (!slot) check(saved.date.getTime() + 3 * IO_MS + 1000 < Date.parse(r.validUntil));
      const state = settleManagedBudget(saved.state, managedSettlementProof(r, evidenceDigest), this.clock(saved, 1));
      if (!slot) {
        const bytes = Buffer.from(JSON.stringify(envelope));
        const result = await this.container.getBlockBlobClient(slotName).uploadData(bytes, { conditions: { ifNoneMatch: "*" },
          abortSignal: this.signal(), maxSingleShotSize: 128 * 1024, concurrency: 1,
          blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" } });
        check(result.etag);
      }
      await this.replace(saved, state);
      return { status: "applied" as const };
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
      if (o!.scope === "standard") {
        const p = await this.profile(saved.state, o!.profileDigest);
        check(p && p.pricingDigest === o!.pricingDigest && o!.cases.every(id => p.cases.includes(id)));
      }
      return { processingMonth: o!.processingMonth, expiresAt: new Date(deadline).toISOString() };
    });
  }
}
