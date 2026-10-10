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

const MAX_INPUT = 2 * 1024 ** 2;
export const MAX_SESSION_REQUESTS = 16; // Bootstrap consumes up to four of the process-wide 20 connections.
const databaseWindowSchema = operatorTicketSchema.shape.databaseWindow.unwrap();
type DatabaseWindow = z.infer<typeof databaseWindowSchema>;
const environmentSchema = z.object({ DEPLOYMENT_KIND: z.literal("trial"), TRIAL_POLICY_JSON: z.string(),
  TRIAL_POLICY_SIGNATURE: z.string(), TRIAL_POLICY_PUBLIC_KEY: z.string() }).strict();
export const trialSessionInput = z.object({
  environment: environmentSchema, access: operatorTicketSchema,
  signingPrivateKey: z.string().min(1).max(8192), databaseWindow: databaseWindowSchema,
  bootstrap: trialBootstrapInput.omit({ environment: true, access: true, recoveryDirectory: true }),
  operatorDatabaseUrl: z.string().min(1).max(8192), recoveryDirectory: z.string().min(1),
  requests: z.array(z.unknown()).max(MAX_SESSION_REQUESTS),
}).strict();
const permitSchema = z.object({ type: z.literal("permit"), lifecycleId: z.uuidv4(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), guardianNonce: z.string().min(1).max(100),
  useUntil: z.iso.datetime(), permitUntil: z.iso.datetime() }).strict();
export type SessionClock = { utc(): number; monotonic(): number };
const systemClock: SessionClock = { utc: () => Date.now(), monotonic: () => performance.now() };
const failure = () => new TrialError("trial_session_reconciliation_required");
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
  if (!prior || !original.localOperator || original.phase !== "initial" ||
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
  const bootstrap = trialBootstrapInput.parse({ ...input.bootstrap, environment, access, recoveryDirectory: input.recoveryDirectory });
  const common = { environment, access, databaseUrl: input.operatorDatabaseUrl, recoveryDirectory: input.recoveryDirectory };
  // References are restricted to the prior sample's exact case and its two result
  // fields. Fully materialized requests are validated before bootstrap starts.
  input.requests.forEach((request, index) => {
    const refs = validateReferences(request, index, input.requests);
    if (!refs.length) trialOperatorInput.parse({ ...common, request });
  });
  return { bootstrap, common, requests: input.requests, databaseWindow: actual };
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
export async function saveTrialRuntimePolicy(prepared: PreparedSession, io: RuntimePolicyIO = { inspect: lstat, create: open }) {
  const environment = environmentSchema.parse(prepared.common.environment), policy = readTrialPolicy(environment);
  const directory = prepared.common.recoveryDirectory, hash = (value: string) => createHash("sha256").update(value).digest("hex");
  if (!isAbsolute(directory) || hash(resolve(directory)) !== policy.localOperator?.recoveryDirectoryDigest) throw failure();
  const stat = await io.inspect(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure();
  const serialized = JSON.stringify(environment) + "\n";
  if (Buffer.byteLength(serialized) > 65536) throw failure();
  const handle = await io.create(join(directory, "trial-runtime-policy.json"), "wx", 0o600);
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  return { sha256: hash(serialized) };
}
export type SessionAdapters = { runtimePolicy(prepared: PreparedSession): Promise<unknown>;
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
  adapters: SessionAdapters = { runtimePolicy: saveTrialRuntimePolicy, bootstrap: runTrialBootstrap, operator: runTrialOperator }) {
  await permit.wait(); permit.check();
  await abortable(adapters.runtimePolicy(prepared), permit.signal); permit.check();
  const bootstrapResult = record(await abortable(adapters.bootstrap(prepared.bootstrap), permit.signal)); permit.check();
  if (bootstrapResult.status !== (prepared.bootstrap.mode === "apply" ? "bootstrapped" : "reconciled") ||
    bootstrapResult.cases !== prepared.bootstrap.manifest.cases.length || !Number.isSafeInteger(bootstrapResult.databaseBaselineBytes) ||
    Number(bootstrapResult.databaseBaselineBytes) < 0 || bootstrapResult.automaticResend !== false) throw failure();
  const results: unknown[] = [];
  for (const [index, template] of prepared.requests.entries()) {
    permit.check(); const request = structuredClone(template), refs = validateReferences(request, index, prepared.requests);
    for (const { value } of refs) {
      const { requestIndex, field } = value.$sessionResult, result = record(results[requestIndex]);
      if (result.status !== "saved" || !Object.hasOwn(result, field)) throw failure();
      record(record(request).setting)[field] = structuredClone(result[field]);
    }
    const input = trialOperatorInput.parse({ ...prepared.common, request });
    permit.check(); const result = await abortable(adapters.operator(input), permit.signal); permit.check();
    requireOperatorResult(request, result); results.push(result);
  }
  return { status: "completed" as const, completedRequests: results.length };
}

/** NDJSON: first line is the private payload, later lines are short permit frames.
 * EOF never means 'input complete': the parent keeps the pipe open until exit. */
export async function runTrialSessionStdin(input: Readable, options: {
  adapters?: SessionAdapters; clock?: SessionClock; onStop: () => void;
}) {
  let size = 0, pending = Buffer.alloc(0), first = true, permit: SessionPermit | undefined;
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
      if (size > MAX_INPUT) throw failure();
      pending = Buffer.concat([pending, bytes]);
      for (;;) {
        const end = pending.indexOf(10); if (end < 0) break;
        const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
        if (!line.length) throw failure();
        const value: unknown = JSON.parse(line.toString("utf8"));
        if (first) { first = false; resolveInitial(value); }
        else if (permit) permit.grant(value);
        else { if (queued.length >= 8) throw failure(); queued.push(value); }
      }
    } catch { stop(); }
  };
  input.on("data", data); input.on("end", stop); input.on("error", stop); input.on("close", stop);
  const startup = setTimeout(stop, 5000);
  try {
    const value = await abortable(initial, channel.signal);
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
