import { createHash } from "node:crypto";
import { z } from "zod";
import type { ContainerClient } from "@azure/storage-blob";
import { readTrialPolicy, requireTrialActive, trialPolicyDigest, TrialError, type TrialPolicy } from "./policy";
import { assertTrialPrivate, trialContainer } from "./storage";

const quantity = z.number().int().nonnegative().safe();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const pricingSchema = z.object({ input: quantity, output: quantity, job: quantity }).strict();
const callSchema = z.object({ ordinal: quantity, hash: digest, input: quantity, output: quantity,
  usage: z.object({ input: quantity, output: quantity }).strict().nullable() }).strict();
const operationSchema = z.object({ id: digest, intent: digest, policy: digest,
  phase: z.enum(["initial", "trial"]), month: z.string().regex(/^\d{4}-\d{2}$/),
  kind: z.enum(["compare", "extract", "storage", "artifact", "database", "package"]), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  image:z.string().nullable(),packages:quantity,sourceBytes:quantity,
  normal: quantity, mini: quantity, jobs: quantity, seconds: quantity, bytes: quantity, dbBytes: quantity, yen: quantity,
  storageKey: z.string().max(512).nullable(), terminal: z.boolean(), receiptExecution:z.string().max(180).nullable(),
  status: z.enum(["reserved", "dispatching", "running", "complete", "unknown"]),
  pricing: pricingSchema,
  execution: z.string().max(180).nullable(), calls: z.array(callSchema).max(3),
}).strict();
export const trialLedgerSchema = z.object({ schema: z.literal(1), binding: digest, revision: quantity,
  costFloor:z.object({initial:quantity,retained:quantity,months:z.record(z.string().regex(/^\d{4}-\d{2}$/),quantity),databaseBaselineBytes:quantity}).strict(),
  operations: z.array(operationSchema).max(1024) }).strict();
export type TrialOperation = z.infer<typeof operationSchema>;
export type TrialLedgerState = z.infer<typeof trialLedgerSchema>;
export const TRIAL_LEDGER_KEY = "trial-v1/state.json";
export const trialHash = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
/** Intentionally stable across code/profile/phase changes. There is one lifetime ledger. */
export function trialBinding(p: TrialPolicy) {
  return trialHash(JSON.stringify({ auth: p.auth, database: p.database, storage: p.storage,
    identity: p.identity, job: p.jobResourceId.toLowerCase(), environment: p.environmentResourceId.toLowerCase() }));
}
export function emptyTrialLedger(p: TrialPolicy): TrialLedgerState {
  if(!p.cost)throw new TrialError("trial_cost_review_required");
  return { schema: 1, binding: trialBinding(p), revision: 0, operations: [],costFloor:{initial:p.cost.initialOtherYen,retained:p.cost.retainedOtherYen,
    months:{[trialMonth(Date.parse(p.cost.checkedAt))]:p.cost.monthOtherYen},databaseBaselineBytes:p.cost.databaseBaselineBytes} };
}
export function trialMonth(now: number) { return new Date(now + 9 * 60 * 60_000).toISOString().slice(0, 7); }
export function requireTrialCost(p: TrialPolicy, now: number) {
  requireTrialActive(p, now);
  if (!p.cost || now < Date.parse(p.cost.checkedAt) || now >= Date.parse(p.cost.validUntil)) throw new TrialError("trial_cost_review_required");
  return p.cost;
}
export function trialCallYen(p: TrialPolicy, role: "normal" | "mini", input: number, output: number) {
  const rate = p.cost?.[role];
  if (!rate || !Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0 ||
    input > (role === "normal" ? 150_000 : 50_000) || output > 8192) throw new TrialError("trial_budget_stopped");
  return Math.ceil((input * rate.inputYenPerMillion + output * rate.outputYenPerMillion) / 1_000_000);
}
export function checkTrialLedger(s: TrialLedgerState, p: TrialPolicy) {
  trialLedgerSchema.parse(s);
  if (s.binding !== trialBinding(p) || s.costFloor.databaseBaselineBytes!==p.cost?.databaseBaselineBytes || new Set(s.operations.map(o => o.id)).size !== s.operations.length ||
    new Set(s.operations.map(o => o.intent)).size !== s.operations.length)
    throw new TrialError("trial_budget_stopped");
  for (const o of s.operations) {
    if (o.normal > 3 || o.mini > 1 || o.jobs > 1 || o.seconds > 1800 || Date.parse(o.createdAt)>=Date.parse(o.expiresAt) ||
      o.month!==trialMonth(Date.parse(o.createdAt)) ||
      (o.kind==="compare" ? o.mini!==0||o.jobs!==1 : o.normal!==0||o.jobs!==0||o.seconds!==0) ||
      (o.kind!=="extract" && o.mini!==0) ||
      (o.kind==="package"?o.packages!==1||o.sourceBytes<1:o.packages!==0||o.sourceBytes!==0) ||
      (o.kind==="compare"?!o.image:o.image!==null) ||
      o.calls.some((c,i) => c.ordinal !== i + 1 || (c.usage && (c.usage.input>c.input || c.usage.output>c.output))) ||
      o.calls.length > (o.kind === "compare" ? 3 : o.kind === "extract" ? 1 : 0)) throw new TrialError("trial_budget_stopped");
  }
}
function checkCaps(s: TrialLedgerState, p: TrialPolicy, now: number) {
  checkTrialLedger(s, p);
  const cost = requireTrialCost(p, now), ops = s.operations;
  s.costFloor.initial=Math.max(s.costFloor.initial,cost.initialOtherYen);
  s.costFloor.retained=Math.max(s.costFloor.retained,cost.retainedOtherYen);
  const month=trialMonth(now);s.costFloor.months[month]=Math.max(s.costFloor.months[month]??0,cost.monthOtherYen);
  const sum = (items: TrialOperation[], key: "normal" | "mini" | "jobs" | "seconds" | "bytes" | "dbBytes" | "yen") => items.reduce((n,o) => n + o[key], 0);
  for (const [phase, caps] of [["initial", [24,12,12,21600]], ["trial", [12,12,12,10800]], ["all", [36,24,24,32400]]] as const) {
    const selected = phase === "all" ? ops : ops.filter(o => o.phase === phase);
    if ((["normal","mini","jobs","seconds"] as const).some((k,i) => sum(selected,k) > caps[i])) throw new TrialError("trial_quantity_limit");
  }
  const initial = sum(ops.filter(o => o.phase === "initial"), "yen") + s.costFloor.initial;
  const retained = sum(ops.filter(o => o.phase === "trial"), "yen") + s.costFloor.retained;
  const monthly = sum(ops.filter(o => o.phase === "trial" && o.month === month), "yen") + s.costFloor.months[month];
  if (initial > 4500 || retained >= 9000 || monthly >= 1800 || initial + retained > 15000 ||
    initial+retained > cost.sharedRemainingYen || sum(ops,"bytes") + 4*1024**2 > 3 * 1024 ** 3 || sum(ops,"dbBytes") > 192*1024**2 ||
    ops.reduce((n,o)=>n+o.packages,0)>2||ops.reduce((n,o)=>n+o.sourceBytes,0)>2*1024**3)
    throw new TrialError("trial_budget_stopped");
}
export interface TrialLedgerIO {
  read(): Promise<{ state: TrialLedgerState; etag: string }>;
  replace(state: TrialLedgerState, etag: string): Promise<void>;
}
export class TrialBlobLedgerIO implements TrialLedgerIO {
  constructor(private readonly container: ContainerClient) {}
  async read() {
    try {
      await assertTrialPrivate(this.container);
      const blob = this.container.getBlobClient(TRIAL_LEDGER_KEY);
      const props = await blob.getProperties({ abortSignal: AbortSignal.timeout(20_000) });
      if (!props.etag || !props.contentLength || props.contentLength > 4 * 1024 ** 2) throw new TrialError();
      const bytes = await blob.downloadToBuffer(0, props.contentLength, { conditions: { ifMatch: props.etag }, abortSignal: AbortSignal.timeout(20_000) });
      return { state: trialLedgerSchema.parse(JSON.parse(bytes.toString("utf8"))), etag: props.etag };
    } catch { throw new TrialError("trial_ledger_unavailable"); }
  }
  async replace(state: TrialLedgerState, etag: string) {
    try {
      await assertTrialPrivate(this.container);
      const bytes = Buffer.from(JSON.stringify(trialLedgerSchema.parse(state)));
      if (bytes.length > 4 * 1024 ** 2) throw new TrialError();
      await this.container.getBlockBlobClient(TRIAL_LEDGER_KEY).uploadData(bytes, {
        conditions: { ifMatch: etag }, abortSignal: AbortSignal.timeout(20_000),
        blobHTTPHeaders: { blobContentType: "application/json", blobCacheControl: "private, no-store" },
      });
    } catch { throw new TrialError("trial_ledger_write_unknown"); }
  }
}
/** No mutation retries. A missing ledger is an operator setup failure, not a new budget. */
export class TrialLedger {
  constructor(readonly policy: TrialPolicy, private readonly io: TrialLedgerIO, private readonly now = Date.now) {}
  static configured() { const p = readTrialPolicy(); return new TrialLedger(p, new TrialBlobLedgerIO(trialContainer("budget",p))); }
  async read() { const saved = await this.io.read(); checkTrialLedger(saved.state,this.policy); return saved; }
  async inspect(id: string) { return (await this.read()).state.operations.find(o => o.id === id) ?? null; }
  private async update(id: string, change: (o: TrialOperation) => void, admission = false) {
    const saved = await this.read(), o = saved.state.operations.find(o => o.id === id);
    if (!o) throw new TrialError("trial_reservation_missing");
    if (admission) {
      requireTrialCost(this.policy,this.now());
      if (o.policy !== trialPolicyDigest(this.policy) || this.now() >= Date.parse(o.expiresAt)) throw new TrialError("trial_outside_period");
    }
    change(o); saved.state.revision++;
    checkTrialLedger(saved.state,this.policy);
    if (admission) checkCaps(saved.state,this.policy,this.now());
    await this.io.replace(saved.state,saved.etag); return o;
  }
  async reserve(input: { id: string; intent: string; kind: TrialOperation["kind"]; bytes?: number; dbBytes?: number; sourceBytes?:number; storageKey?:string; noAi?: boolean }) {
    const saved = await this.read();
    const existing = saved.state.operations.find(o => o.id === input.id);
    if (existing) {
      if (existing.intent !== input.intent || existing.kind !== input.kind) throw new TrialError("trial_intent_mismatch");
      return { created: false, operation: existing };
    }
    if (saved.state.operations.some(o => o.intent === input.intent)) throw new TrialError("trial_intent_mismatch");
    if (input.kind === "compare" && saved.state.operations.some(o=>o.kind==="compare"&&!o.terminal)) throw new TrialError("trial_job_busy");
    const now = this.now(), cost = requireTrialCost(this.policy,now), compare = input.kind === "compare", extract = input.kind === "extract";
    const normal = compare && !input.noAi ? 3 : 0, mini = extract ? 1 : 0;
    const o = operationSchema.parse({ id: input.id, intent: input.intent, policy: trialPolicyDigest(this.policy),
      phase: this.policy.phase, month: trialMonth(now), kind: input.kind, createdAt: new Date(now).toISOString(),
      image:compare?this.policy.image??null:null,packages:input.kind==="package"?1:0,sourceBytes:input.sourceBytes??0,
      expiresAt: new Date(Math.min(Date.parse(this.policy.endsAt), now + (compare ? 15 * 60_000 : 90_000))).toISOString(),
      normal, mini, jobs: compare ? 1 : 0, seconds: compare ? 1800 : 0, bytes: input.bytes ?? 0, dbBytes:input.dbBytes??0,
      storageKey:input.storageKey??null,terminal:!compare,receiptExecution:null,
      yen: normal * trialCallYen(this.policy,"normal",150_000,8192) + mini * trialCallYen(this.policy,"mini",50_000,8192) +
        (compare ? Math.ceil(cost.jobYenPerHour / 2) : 0), status: "reserved", execution: null, calls: [],
      pricing: { input:cost[compare ? "normal" : "mini"].inputYenPerMillion,
        output:cost[compare ? "normal" : "mini"].outputYenPerMillion,job:cost.jobYenPerHour } });
    saved.state.operations.push(o); saved.state.revision++; checkCaps(saved.state,this.policy,now);
    await this.io.replace(saved.state,saved.etag); return { created: true, operation: o };
  }
  async claimDispatch(id: string) { return this.update(id,o => {
    if (o.status !== "reserved") throw new TrialError("trial_already_dispatched"); o.status = "dispatching";
  },true); }
  async claimWorker(id: string, execution: string) { return this.update(id,o => {
    if (o.kind !== "compare" || !["dispatching","unknown"].includes(o.status) || o.execution !== null ||
      (o.receiptExecution!==null&&o.receiptExecution!==execution) || o.terminal || o.calls.length || !/^[a-z0-9-]{1,100}$/.test(execution)) throw new TrialError("trial_worker_rejected");
    o.execution = execution; o.status = "running";
  },true); }
  async reserveCall(id: string, e: { ordinal: number; requestSha256: string; estimatedInputTokens: number; maximumOutputTokens: number }) {
    return this.update(id,o => {
      const role = o.kind === "compare" ? "normal" : "mini";
      if ((o.kind === "compare" ? o.status !== "running" || !o.execution : o.kind !== "extract" || o.status !== "dispatching") ||
        e.ordinal !== o.calls.length + 1 || e.ordinal > (o.normal + o.mini) ||
        o.calls.some(c => !c.usage)) throw new TrialError("trial_dispatch_stopped");
      trialCallYen(this.policy,role,e.estimatedInputTokens,e.maximumOutputTokens);
      o.calls.push({ ordinal:e.ordinal,hash:e.requestSha256,input:e.estimatedInputTokens,output:e.maximumOutputTokens,usage:null });
    },true);
  }
  async reconcileCall(id: string, e: { ordinal: number; inputTokens: number; outputTokens: number }) {
    // Already-sent usage is retained even after the permission window closes.
    return this.update(id,o => {
      const c = o.calls[e.ordinal - 1];
      if (!c || c.ordinal !== e.ordinal || e.inputTokens > c.input || e.outputTokens > c.output) throw new TrialError("trial_usage_mismatch");
      trialCallYen(this.policy,o.kind === "compare" ? "normal" : "mini",e.inputTokens,e.outputTokens);
      const usage = { input:e.inputTokens,output:e.outputTokens };
      if (c.usage && JSON.stringify(c.usage) !== JSON.stringify(usage)) throw new TrialError("trial_usage_mismatch");
      c.usage = usage;
    });
  }
  async complete(id: string, proof: { persisted: true; execution?: string; reconciled?:true }) { return this.update(id,o => {
    if (o.status === "complete") return;
    if (!proof.persisted || (o.kind === "compare" ? o.status !== "running" || o.execution !== proof.execution :
      o.status !== "dispatching" && !(proof.reconciled && ["artifact","storage","package","database"].includes(o.kind) && o.status==="unknown")) || (o.kind === "extract" && o.calls.length !== 1)) throw new TrialError("trial_result_unconfirmed");
    if (o.calls.some(c => !c.usage)) throw new TrialError("trial_usage_unknown");
    // Job runtime remains reserved until an operator reconciles terminal ARM evidence.
    // AI unused allowance is released only after awaited result persistence.
    if (o.kind === "compare") o.normal = o.calls.length;
    if (o.kind === "extract") o.mini = o.calls.length;
    if (o.kind === "compare" || o.kind === "extract") o.yen = o.calls.reduce((n,c) => n + Math.ceil((c.usage!.input * o.pricing.input + c.usage!.output * o.pricing.output) / 1_000_000),0) +
      (o.jobs ? Math.ceil(o.pricing.job * o.seconds / 3600) : 0);
    o.status = "complete";
  }); }
  async markUnknown(id: string, dispatchOnly = false) { return this.update(id,o => {
    if (o.status !== "complete" && (!dispatchOnly || o.status === "dispatching")) o.status = "unknown";
  }); }
  async recordExecution(id:string,execution:string) { return this.update(id,o=>{
    if(o.kind!=="compare"||o.execution&&o.execution!==execution||o.receiptExecution&&o.receiptExecution!==execution||!/^[a-z0-9-]{1,100}$/.test(execution))throw new TrialError();
    o.receiptExecution=execution;
  }); }
  async reconcileTerminalJob(id:string,evidence:{execution:string;seconds:number;databaseConfirmed:boolean}) {
    return this.update(id,o=>{
      if(o.kind!=="compare"||(o.execution??o.receiptExecution)!==evidence.execution||!evidence.databaseConfirmed||
        !Number.isSafeInteger(evidence.seconds)||evidence.seconds<0||evidence.seconds>1800)throw new TrialError("trial_terminal_unconfirmed");
      if(o.terminal){if(o.seconds!==evidence.seconds)throw new TrialError();return;}
      o.seconds=evidence.seconds;o.terminal=true;
      if(o.status==="complete")o.yen=o.calls.reduce((n,c)=>n+Math.ceil((c.usage!.input*o.pricing.input+c.usage!.output*o.pricing.output)/1_000_000),0)+Math.ceil(o.pricing.job*o.seconds/3600);
    });
  }
}
