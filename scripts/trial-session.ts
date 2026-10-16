import { createHash, createPrivateKey, createPublicKey, sign, timingSafeEqual } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";
import { trialBootstrapInput, runTrialBootstrap } from "./trial-bootstrap";
import { trialOperatorInput, runTrialOperator } from "./trial-operator";
import { OperatorAccess, operatorPolicyBinding, operatorTicketDigest, operatorTicketSchema } from "../src/lib/trial/operator-access";
import { readTrialPolicy, trialPolicyBytes, trialPolicySchema, TrialError } from "../src/lib/trial/policy";
import { managedSettingSchema } from "../src/lib/patent-watch/managed-types";
import { parseTrialStrictJson } from "../src/lib/trial/strict-json";

import { trialAzureCliPythonSchema } from "./trial-owner-token";

const MAX_INPUT = 2 * 1024 ** 2;
export const MAX_SESSION_REQUESTS = 16; // Bootstrap consumes up to four of the process-wide 20 connections.
export const MAX_BOOTSTRAP_BASELINE_BYTES = 64 * 1024 ** 2;
export const databaseWindowSchema = operatorTicketSchema.shape.databaseWindow.unwrap();
type DatabaseWindow = z.infer<typeof databaseWindowSchema>;
export const environmentSchema = z.object({ DEPLOYMENT_KIND: z.literal("trial"), TRIAL_POLICY_JSON: z.string(),
  TRIAL_POLICY_SIGNATURE: z.string(), TRIAL_POLICY_PUBLIC_KEY: z.string() }).strict();
export const trialSessionInput = z.object({
  azureCliPython: trialAzureCliPythonSchema, environment: environmentSchema, access: operatorTicketSchema,
  signingPrivateKey: z.string().min(1).max(8192), databaseWindow: databaseWindowSchema,
  bootstrap: trialBootstrapInput.omit({ environment: true, access: true, recoveryDirectory: true, azureCliPython: true }),
  operatorDatabaseUrl: z.string().min(1).max(8192), recoveryDirectory: z.string().min(1),
  requests: z.array(z.unknown()).max(MAX_SESSION_REQUESTS),
}).strict();
const permitSchema = z.object({ type: z.literal("permit"), lifecycleId: z.uuidv4(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), guardianNonce: z.string().min(1).max(100),
  useUntil: z.iso.datetime(), permitUntil: z.iso.datetime() }).strict();
export type SessionClock = { utc(): number; monotonic(): number };
const systemClock: SessionClock = { utc: () => Date.now(), monotonic: () => performance.now() };
const failure = () => new TrialError("trial_session_reconciliation_required");
type SessionCommon = { azureCliPython: string; environment: z.infer<typeof environmentSchema>; access: z.infer<typeof operatorTicketSchema>;
  databaseUrl: string; recoveryDirectory: string };
// Keep the already-verified private KeyObject only in a captured, single-use
// signer. It cannot be serialized into the prepared state or a runtime artifact.
const baselineSigners = new WeakMap<object, (bytes: number) => SessionCommon>();
const measuredSessions = new WeakSet<object>();
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
const referenceSchema = z.object({ $sessionResult: z.object({ requestIndex: z.number().int().nonnegative(),
  field: z.enum(["base", "source"]) }).strict() }).strict();
const referencedSettingRequest = z.object({ command: z.literal("setting-save"), setting: managedSettingSchema.extend({
  base: z.union([managedSettingSchema.shape.base, referenceSchema]),
  source: z.union([managedSettingSchema.shape.source, referenceSchema]),
}) }).strict();
function references(value: unknown, path = "", found: { path: string; value: z.infer<typeof referenceSchema> }[] = []) {
  if (value && typeof value === "object") {
    if (Object.hasOwn(value, "$sessionResult")) found.push({ path, value: referenceSchema.parse(value) });
    else for (const [key, child] of Object.entries(value)) references(child, path ? `${path}.${key}` : key, found);
  }
  return found;
}
function validateReferences(request: unknown, index: number, requests: unknown[]) {
  const r = record(request), refs = references(r);
  if (refs.length) referencedSettingRequest.parse(r);
  for (const ref of refs) {
    const { requestIndex, field } = ref.value.$sessionResult;
    const prior = record(requests[requestIndex]);
    if (r.command !== "setting-save" || ref.path !== `setting.${field}` || requestIndex >= index ||
      prior.command !== "sample-save" || prior.caseId !== record(r.setting).caseId) throw failure();
  }
  if (new Set(refs.map(ref => ref.value.$sessionResult.requestIndex)).size > 1) throw failure();
  return refs;
}

/** An existing signed policy and its signed ticket digest are the authority.
 * Only the ticket DB window and derived ticket digest/signature change. Policy
 * dates remain fixed so the same runtime policy survives the DB bootstrap window.
 * The returned private values are passed directly to local adapters, never stdout. */
export function prepareTrialSession(value: unknown, clock: SessionClock = systemClock) {
  const input = trialSessionInput.parse(value), original = readTrialPolicy(input.environment);
  const ticket = operatorTicketSchema.parse(input.access), prior = ticket.databaseWindow, actual = input.databaseWindow;
  if (!prior || !original.localOperator || !original.cost || original.phase !== "initial" ||
    operatorTicketDigest(ticket) !== original.localOperator.ticketDigest || ticket.policyDigest !== operatorPolicyBinding(original)) throw failure();
  for (const key of ["lifecycleId", "guardianNonce", "ruleId", "journalUrl"] as const) if (prior[key] !== actual[key]) throw failure();
  const began = Date.parse(actual.jobStartedAt), end = Date.parse(actual.useUntil), now = clock.utc();
  if (end - began !== 600_000 || began < Date.parse(original.startsAt) || end > Date.parse(original.endsAt) ||
    began < Date.parse(ticket.startsAt) || end > Date.parse(ticket.endsAt) || now < began || now >= end) throw failure();
  const oldAccess = new OperatorAccess(ticket, original, clock);
  try { oldAccess.check(0); } finally { oldAccess.dispose(); }
  const privateKey = createPrivateKey(input.signingPrivateKey), publicKey = createPublicKey(input.environment.TRIAL_POLICY_PUBLIC_KEY);
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  const actualDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  if (privateKey.asymmetricKeyType !== "ed25519" || publicKey.asymmetricKeyType !== "ed25519" ||
    publicDer.length !== actualDer.length || !timingSafeEqual(publicDer, actualDer)) throw failure();
  const policy = trialPolicySchema.parse(original);
  const access = operatorTicketSchema.parse({ ...ticket, policyDigest: operatorPolicyBinding(policy), databaseWindow: actual });
  policy.localOperator = { ...original.localOperator, ticketDigest: operatorTicketDigest(access) };
  const environment = { ...input.environment, TRIAL_POLICY_JSON: JSON.stringify(policy),
    TRIAL_POLICY_SIGNATURE: sign(null, trialPolicyBytes(policy), privateKey).toString("base64") };
  const verified = readTrialPolicy(environment), checked = new OperatorAccess(access, verified, clock);
  try { checked.check(0); } finally { checked.dispose(); }
  const bootstrap = trialBootstrapInput.parse({ ...input.bootstrap, azureCliPython: input.azureCliPython, environment, access, recoveryDirectory: input.recoveryDirectory });
  const common = { azureCliPython: input.azureCliPython, environment, access, databaseUrl: input.operatorDatabaseUrl, recoveryDirectory: input.recoveryDirectory };
  // References are restricted to the prior sample's exact case and its two result
  // fields. Fully materialized requests are validated before bootstrap starts.
  input.requests.forEach((request, index) => {
    const refs = validateReferences(request, index, input.requests);
    if (!refs.length) trialOperatorInput.parse({ ...common, request });
  });
  const prepared = { bootstrap, common, requests: input.requests, databaseWindow: actual };
  baselineSigners.set(prepared, (bytes: number) => {
    const measured = trialPolicySchema.parse({ ...policy, cost: { ...policy.cost!, databaseBaselineBytes: bytes } });
    const measuredAccess = operatorTicketSchema.parse({ ...access, policyDigest: operatorPolicyBinding(measured) });
    measured.localOperator = { ...policy.localOperator!, ticketDigest: operatorTicketDigest(measuredAccess) };
    const measuredEnvironment = { ...environment, TRIAL_POLICY_JSON: JSON.stringify(measured),
      TRIAL_POLICY_SIGNATURE: sign(null, trialPolicyBytes(measured), privateKey).toString("base64") };
    const confirmed = readTrialPolicy(measuredEnvironment), measuredCheck = new OperatorAccess(measuredAccess, confirmed, clock);
    try { measuredCheck.check(0); } finally { measuredCheck.dispose(); }
    return { ...common, environment: measuredEnvironment, access: measuredAccess };
  });
  return prepared;
}

/** The sole post-bootstrap policy update: an actually measured bounded DB size.
 * Prices, budget estimates, policy/grant dates and DB targets are left intact. */
export function bindTrialSessionBaseline(prepared: ReturnType<typeof prepareTrialSession>, bytes: number) {
  const signer = baselineSigners.get(prepared); baselineSigners.delete(prepared);
  if (!signer || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BOOTSTRAP_BASELINE_BYTES) throw failure();
  const measured = { ...prepared, common: signer(bytes) }; measuredSessions.add(measured); return measured;
}

/** Parent EOF, permit expiry and clock rollback are fatal for the whole DB worker.
 * Production onStop terminates the process: an unacknowledged SQL stays unknown. */
export class SessionPermit {
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private high: number;
  private lastWall: number;
  private anchor: number;
  private mono: number;
  private until = 0;
  private readonly firstDeadline: number;
  private timer: ReturnType<typeof setInterval>;
  private ready?: () => void;
  private readonly readyPromise: Promise<void>;
  constructor(readonly window: DatabaseWindow, private readonly onStop: () => void, private readonly clock: SessionClock = systemClock) {
    this.high = this.lastWall = this.anchor = clock.utc(); this.mono = clock.monotonic();
    this.firstDeadline = Math.min(this.high + 5000, Date.parse(window.useUntil));
    this.readyPromise = new Promise(resolve => { this.ready = resolve; });
    this.timer = setInterval(() => {
      try { const now = this.now(); if (now >= (this.until || this.firstDeadline) || now >= Date.parse(window.useUntil)) this.stop(); }
      catch { this.stop(); }
    }, 25);
  }
  private now() {
    const wall = this.clock.utc(), mono = this.clock.monotonic();
    if (!Number.isFinite(wall) || !Number.isFinite(mono) || wall < this.lastWall || mono < this.mono) throw failure();
    this.high = Math.max(this.high, wall, this.anchor + mono - this.mono);
    this.lastWall = wall; this.anchor = this.high; this.mono = mono;
    return this.high;
  }
  stop() {
    if (this.signal.aborted) return;
    clearInterval(this.timer); this.controller.abort();
    try { this.onStop(); } catch { /* A reporting failure cannot revive the permit. */ }
  }
  grant(value: unknown) {
    try {
      const p = permitSchema.parse(value), now = this.now(), until = Date.parse(p.permitUntil);
      if (this.signal.aborted || now >= (this.until || this.firstDeadline) || p.lifecycleId !== this.window.lifecycleId || p.bindingDigest !== this.window.bindingDigest ||
        p.guardianNonce !== this.window.guardianNonce || p.useUntil !== this.window.useUntil || until <= now ||
        until < this.until || until > now + 10000 || until > Date.parse(this.window.useUntil)) throw failure();
      this.until = until; this.ready?.(); this.ready = undefined;
    } catch { this.stop(); throw failure(); }
  }
  check() {
    try { if (this.signal.aborted || this.now() >= this.until || this.now() >= Date.parse(this.window.useUntil)) throw failure(); }
    catch { this.stop(); throw failure(); }
  }
  async wait() { await abortable(this.readyPromise, this.signal); this.check(); }
  dispose() { clearInterval(this.timer); }
}
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw failure();
  let abort: () => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(failure()); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([work, stopped]); } finally { signal.removeEventListener("abort", abort); }
}
type PreparedSession = ReturnType<typeof prepareTrialSession>;
export type RuntimePolicyIO = {
  inspect(path: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  create(path: string, flags: "wx", mode: number): Promise<{ writeFile(value: string): Promise<void>; sync(): Promise<void>; close(): Promise<void> }>;
};
/** The launcher ACL-checks this existing owner-private directory. Exclusive
 * creation is intentional: a partial/unknown prior save is never overwritten. */
export async function saveTrialRuntimePolicy(prepared: PreparedSession, phase: "pending" | "final", io: RuntimePolicyIO = { inspect: lstat, create: open }) {
  if ((phase === "pending" && !baselineSigners.has(prepared)) || (phase === "final" && !measuredSessions.has(prepared))) throw failure();
  const environment = environmentSchema.parse(prepared.common.environment), policy = readTrialPolicy(environment);
  const directory = prepared.common.recoveryDirectory, hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (!isAbsolute(directory) || hash(resolve(directory)) !== policy.localOperator?.recoveryDirectoryDigest) throw failure();
  const stat = await io.inspect(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
  const serialized = JSON.stringify(environment) + "\n";
  if (Buffer.byteLength(serialized) > 65536) throw failure();
  if (phase !== "pending" && phase !== "final") throw failure();
  const handle = await io.create(join(directory, phase === "pending" ? "trial-runtime-policy.pending.json" : "trial-runtime-policy.json"), "wx", 0o600);
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  return { sha256: hash(serialized) };
}
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const bootstrapReceiptsSchema = z.array(z.object({ name: z.string().regex(/^operator-[a-f0-9]{64}\.jsonl$/), sha256: sha256Schema }).strict()).min(1).max(512);
export function trialProofCanonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(trialProofCanonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + trialProofCanonical(record(value)[key])).join(",") + "}";
  const serialized = JSON.stringify(value); if (serialized === undefined || (typeof value === "number" && !Number.isFinite(value))) throw failure();
  return serialized;
}
const proofHash = (value: string) => createHash("sha256").update(value).digest("hex");
function bootstrapProof(prepared: PreparedSession, result: Record<string, unknown>) {
  if (!measuredSessions.has(prepared)) throw failure();
  const receipts = bootstrapReceiptsSchema.parse(result.receipts);
  if (new Set(receipts.map(r => r.name)).size !== receipts.length || receipts.some((r, i) => i > 0 && receipts[i - 1].name >= r.name)) throw failure();
  const policy = readTrialPolicy(prepared.common.environment), d = policy.database;
  if (result.status !== (prepared.bootstrap.mode === "apply" ? "bootstrapped" : "reconciled") || result.automaticResend !== false ||
    result.cases !== prepared.bootstrap.manifest.cases.length || !Number.isSafeInteger(result.databaseBaselineBytes) ||
    result.databaseBaselineBytes !== policy.cost?.databaseBaselineBytes || Number(result.databaseBaselineBytes) < 0 ||
    Number(result.databaseBaselineBytes) > MAX_BOOTSTRAP_BASELINE_BYTES) throw failure();
  return { schema: 1 as const, receiptScope: "verified_steps_this_invocation" as const,
    bootstrap: { status: String(result.status), databaseBaselineBytes: Number(result.databaseBaselineBytes), cases: Number(result.cases), automaticResend: false as const },
    databaseWindow: prepared.databaseWindow,
    database: { host: d.host, database: d.database, ownerRole: d.ownerRole, migratorUser: d.migratorUser, webUser: d.webUser, workerUser: d.workerUser },
    codeSha: policy.codeSha, bootstrapManifest: prepared.bootstrap.manifest, receipts };
}
export async function saveTrialBootstrapProof(prepared: PreparedSession, result: Record<string, unknown>, io: RuntimePolicyIO = { inspect: lstat, create: open }) {
  const proof = bootstrapProof(prepared, result), policy = readTrialPolicy(prepared.common.environment), directory = prepared.common.recoveryDirectory;
  if (!isAbsolute(directory) || proofHash(resolve(directory)) !== policy.localOperator?.recoveryDirectoryDigest) throw failure();
  const st = await io.inspect(directory); if (!st.isDirectory() || st.isSymbolicLink()) throw failure();
  const serialized = trialProofCanonical(proof) + "\n"; if (Buffer.byteLength(serialized) > 131072) throw failure();
  const handle = await io.create(join(directory, "trial-bootstrap-proof.json"), "wx", 0o600);
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  return { sha256: proofHash(serialized) };
}
export type SessionAdapters = { runtimePolicy(prepared: PreparedSession, phase: "pending" | "final"): Promise<unknown>;
  beforeBootstrap?():Promise<void>; beforeRelease?():Promise<void>;
  bootstrapProof(prepared: PreparedSession, result: Record<string, unknown>): Promise<unknown>;
  bootstrap(value: unknown): Promise<unknown>; operator(value: unknown): Promise<unknown> };
function requireOperatorResult(request: unknown, value: unknown) {
  const r = record(request), result = record(value);
  const positive: Record<string, string> = { "initialize-ledger": "initialized", "sample-save": "saved", "setting-save": "saved",
    "package-preview": "previewed", "package-import": "saved", "package-reconcile": "verified" };
  if (r.command === "status") {
    if (!Array.isArray(result.runs) || !Array.isArray(result.deliveries) || !Number.isSafeInteger(result.ledgerRevision) || Number(result.ledgerRevision) < 0) throw failure();
  } else if (r.command === "job-reconcile") {
    if (result.status !== "completed" || result.executionStatus !== "Succeeded" || result.operationId !== r.runId) throw failure();
  } else if (r.command === "delivery-reconcile") {
    if (result.status !== "stored") throw failure();
  } else if (typeof r.command !== "string" || !positive[r.command] || result.status !== positive[r.command]) throw failure();
}

/** Exactly one bootstrap followed by at most 16 explicit commands, no retry loop. */
export async function executeTrialSession(prepared: ReturnType<typeof prepareTrialSession>, permit: SessionPermit,
  adapters: SessionAdapters = { runtimePolicy: saveTrialRuntimePolicy, bootstrapProof: saveTrialBootstrapProof, bootstrap: runTrialBootstrap, operator: runTrialOperator }) {
  await permit.wait(); permit.check();
  await abortable(adapters.runtimePolicy(prepared, "pending"), permit.signal); permit.check();
  if(adapters.beforeBootstrap){await abortable(adapters.beforeBootstrap(),permit.signal);permit.check();}
  const bootstrapResult = record(await abortable(adapters.bootstrap(prepared.bootstrap), permit.signal)); permit.check();
  if (bootstrapResult.status !== (prepared.bootstrap.mode === "apply" ? "bootstrapped" : "reconciled") ||
    bootstrapResult.cases !== prepared.bootstrap.manifest.cases.length || !Number.isSafeInteger(bootstrapResult.databaseBaselineBytes) ||
    Number(bootstrapResult.databaseBaselineBytes) < 0 || Number(bootstrapResult.databaseBaselineBytes) > MAX_BOOTSTRAP_BASELINE_BYTES ||
    bootstrapResult.automaticResend !== false) throw failure();
  const final = bindTrialSessionBaseline(prepared, Number(bootstrapResult.databaseBaselineBytes));
  const proof = bootstrapProof(final,bootstrapResult);
  const results: unknown[] = [];
  for (const [index, template] of prepared.requests.entries()) {
    permit.check(); const request = structuredClone(template), refs = validateReferences(request, index, prepared.requests);
    for (const { value } of refs) {
      const { requestIndex, field } = value.$sessionResult, result = record(results[requestIndex]);
      if (result.status !== "saved" || !Object.hasOwn(result, field)) throw failure();
      record(record(request).setting)[field] = structuredClone(result[field]);
    }
    const input = trialOperatorInput.parse({ ...final.common, request });
    permit.check(); const result = await abortable(adapters.operator(input), permit.signal); permit.check();
    requireOperatorResult(request, result); results.push(result);
  }
  if(adapters.beforeRelease){await abortable(adapters.beforeRelease(),permit.signal);permit.check();}
  const artifact = record(await abortable(adapters.runtimePolicy(final, "final"), permit.signal)); permit.check();
  const finalRuntimePolicySha256 = sha256Schema.parse(artifact.sha256);
  const savedProof = record(await abortable(adapters.bootstrapProof(final, bootstrapResult), permit.signal)); permit.check();
  const bootstrap = { schema: 1, ...proof.bootstrap, finalRuntimePolicySha256, databaseWindowDigest: proofHash(trialProofCanonical(proof.databaseWindow)),
    receiptSetSha256: proofHash(trialProofCanonical(proof.receipts)), receiptCount: proof.receipts.length, proofSha256: sha256Schema.parse(savedProof.sha256) };
  return { status: "completed" as const, completedRequests: results.length, bootstrap };
}

/** NDJSON: first line is the private payload, later lines are short permit frames.
 * EOF never means 'input complete': the parent keeps the pipe open until exit. */
export async function runTrialSessionStdin(input: Readable, options: {
  adapters?: SessionAdapters; clock?: SessionClock; onStop: () => void;
}) {
  let size = 0, frames=0, pending = Buffer.alloc(0), first = true, permit: SessionPermit | undefined;
  let receive:((value:unknown)=>void)|undefined;
  const queued: unknown[] = [], channel = new AbortController();
  let resolveInitial: (value: unknown) => void = () => undefined;
  const initial = new Promise<unknown>(resolve => { resolveInitial = resolve; });
  const stop = () => {
    if (channel.signal.aborted) return;
    channel.abort(); pending = Buffer.alloc(0); queued.length = 0;
    if (permit) permit.stop(); else { try { options.onStop(); } catch { /* fatal remains latched */ } }
  };
  const data = (chunk: Buffer | string) => {
    try {
      if (channel.signal.aborted) return;
      const bytes = Buffer.from(chunk); size += bytes.length;
      if (size > 4*MAX_INPUT) throw failure();
      pending = Buffer.concat([pending, bytes]);
      if(pending.length>MAX_INPUT)throw failure();
      for (;;) {
        const end = pending.indexOf(10); if (end < 0) break;
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (!line.length||++frames>4096) throw failure();
        const value: unknown = parseTrialStrictJson(line);
        if (first) { first = false; resolveInitial(value); }
        else if(receive)receive(value);
        else if (permit) permit.grant(value);
        else { if (queued.length >= 8) throw failure(); queued.push(value); }
      }
    } catch { stop(); }
  };
  input.on("data", data); input.on("end", stop); input.on("error", stop); input.on("close", stop);
  const startup = setTimeout(stop, 5000);
  try {
    const value = await abortable(initial, channel.signal);
    if(record(value).type==="catalog_start"){
      const {runCatalogSession}=await import("./trial-catalog-session");
      clearTimeout(startup);
      return await abortable(runCatalogSession(value,{clock:options.clock,signal:channel.signal,onStop:stop,
        register(fn){receive=fn;for(const frame of queued)fn(frame);queued.length=0;},
        send(frame){process.stdout.write(JSON.stringify(frame)+"\n");}}),channel.signal);
    }
    const prepared = prepareTrialSession(value, options.clock);
    permit = new SessionPermit(prepared.databaseWindow, options.onStop, options.clock);
    clearTimeout(startup);
    if (channel.signal.aborted) throw failure();
    for (const p of queued) permit.grant(p); queued.length = 0;
    return await abortable(executeTrialSession(prepared, permit, options.adapters), channel.signal);
  } catch { stop(); throw failure(); }
  finally {
    clearTimeout(startup); permit?.dispose(); pending = Buffer.alloc(0); queued.length = 0;
    input.off("data", data); input.off("end", stop); input.off("error", stop); input.off("close", stop);
    input.pause();
  }
}

if (require.main === module) {
  // No arguments, private values, exception bodies or adapter results reach logs.
  const fail = () => { process.stdout.write('{"status":"reconciliation_required"}\n'); process.exit(2); };
  if (process.argv.length !== 2) fail();
  process.on("SIGINT", fail); process.on("SIGTERM", fail);
  process.on("uncaughtException", fail); process.on("unhandledRejection", fail);
  void runTrialSessionStdin(process.stdin, { onStop: fail }).then(result => {
    process.stdout.write(JSON.stringify(result) + "\n"); process.exit(0);
  }, fail);
}
