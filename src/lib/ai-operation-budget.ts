import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { capturePatentWatchDiagnostic } from "./patent-watch/diagnostic-context";
import { isPatentWatchStopReason, type PatentWatchStopReason } from "./patent-watch/diagnostic";
import type { DetailObservation } from "./patent-watch/diagnostic-observation";

type Role = "normal" | "fast";
const stopReasons = new WeakMap<object, PatentWatchStopReason>();
const nativeDomExceptionName = Object.getOwnPropertyDescriptor(DOMException.prototype, "name")?.get;
export class AiOperationStopped extends Error {
  readonly reason: PatentWatchStopReason;
  constructor(reason: PatentWatchStopReason = "unknown") {
    super("ai_operation_stopped");
    this.name = "AiOperationStopped";
    this.reason = isPatentWatchStopReason(reason) ? reason : "unknown";
    stopReasons.set(this, this.reason);
    Object.defineProperty(this, "reason", { writable: false, configurable: false });
  }
}

/** Inspect only bounded data properties; never messages, stacks or accessors. */
export function aiOperationStopReason(error: unknown): PatentWatchStopReason | null {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  let aborted = false;
  for (let n = 0; pending.length && n < 64; n++) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    try {
      const reason = stopReasons.get(value);
      if (reason !== undefined) return reason;
      // A name alone establishes no deadline. Keep the old stop behavior.
      let name = Object.getOwnPropertyDescriptor(value, "name")?.value;
      if (value instanceof DOMException) name = nativeDomExceptionName?.call(value);
      if (value instanceof Error && ["AbortError", "TimeoutError"].includes(name)) aborted = true;
      for (const key of ["cause", "lastError", "errors"]) {
        const child = Object.getOwnPropertyDescriptor(value, key)?.value;
        if (key === "errors") {
          if (Array.isArray(child)) for (let i = 0; i < Math.min(child.length, 16); i++) {
            pending.push(Object.getOwnPropertyDescriptor(child, String(i))?.value);
          }
        } else pending.push(child);
      }
    } catch { /* Untrusted exception shape cannot expose or invent a reason. */ }
  }
  return aborted ? "aborted" : null;
}

export function isAiOperationStopped(error: unknown): boolean {
  return aiOperationStopReason(error) !== null;
}

const deadlines = new WeakSet<AbortSignal>();
const managedWatchCapability = Symbol("managed_full_claims_watch");
export type ManagedWatchDispatchJournal = {
  /** Atomic durable reservation ACK is required before network dispatch. */
  reserve(input: { ordinal: number; requestSha256: string; estimatedInputTokens: number; maximumOutputTokens: number }): Promise<void>;
  /** Missing response/usage keeps the reservation; it never authorizes a retry. */
  reconcile(input: { ordinal: number; inputTokens: number; outputTokens: number }): Promise<void>;
};
type ManagedWatchBudgetOptions = {
  capability: typeof managedWatchCapability;
  consumed: number;
  deadline: AbortSignal;
  journal: ManagedWatchDispatchJournal;
};
async function boundedJournalAck(operation: () => Promise<void>, deadline: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([operation(), new Promise<never>((_, reject) => {
      abort = () => reject(new AiOperationStopped("timeout"));
      timer = setTimeout(abort, 20_000);
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) abort();
    })]);
  } finally {
    clearTimeout(timer);
    if (abort) deadline.removeEventListener("abort", abort);
  }
}
export function aiOperationDeadline(milliseconds: number): AbortSignal {
  const signal = AbortSignal.timeout(milliseconds);
  deadlines.add(signal);
  return signal;
}

export class AiOperationBudget {
  private readonly consumed = { normal: 0, fast: 0 };
  private readonly maximum: Readonly<Record<Role, number>>;
  get used(): Readonly<Record<Role, number>> { return Object.freeze({ ...this.consumed }); }
  private stopped: AiOperationStopped | null = null;
  private managedInFlight = false;
  closeManagedScope(): void {
    if (this.managed) this.stopped ??= new AiOperationStopped("unknown");
  }
  constructor(maximum: Record<Role, number>, private readonly managed?: ManagedWatchBudgetOptions) {
    const managedAllowed = managed?.capability === managedWatchCapability && maximum.normal === 41 && maximum.fast === 0 &&
      Number.isSafeInteger(managed.consumed) && managed.consumed >= 0 && managed.consumed <= 41;
    if (managed && !managedAllowed) throw new AiOperationStopped();
    if (!Number.isInteger(maximum.normal) || maximum.normal < 0 || maximum.normal > (managedAllowed ? 41 : 12) ||
        !Number.isInteger(maximum.fast) || maximum.fast < 0 || maximum.fast > 8) throw new AiOperationStopped();
    this.maximum = Object.freeze({ ...maximum });
    if (managedAllowed) this.consumed.normal = managed!.consumed;
  }
  wrapFetch(role: Role, transport: typeof fetch = globalThis.fetch): typeof fetch {
    const boundDiagnostic = capturePatentWatchDiagnostic();
    return async (url, init) => {
      const diagnostic = boundDiagnostic ?? capturePatentWatchDiagnostic();
      let observation: DetailObservation | null = null;
      try { observation = diagnostic?.observation() ?? null; } catch { /* optional */ }
      // Expired callbacks cannot send or poison a still-active shared budget.
      if (diagnostic && !diagnostic.active()) throw new AiOperationStopped("unknown");
      // Snapshot only active requests: expired callbacks cannot poison the run.
      // Validate/hash/send the same URL, headers and RequestInit across journal awaits.
      try { url = String(url); init = init ? { ...init, headers: init.headers ? new Headers(init.headers) : undefined } : undefined; }
      catch { this.stopped ??= new AiOperationStopped("request_rejected"); throw this.stopped; }
      const stop = (reason: PatentWatchStopReason): AiOperationStopped => {
        this.stopped ??= new AiOperationStopped(reason);
        diagnostic?.stop(this.stopped.reason, observation);
        return this.stopped;
      };
      const callerReason = (): PatentWatchStopReason =>
        init?.signal && deadlines.has(init.signal) ? "timeout" : "aborted";
      let estimatedInputTokens = 0;
      let maximumOutputTokens = 0;
      try {
        if (this.stopped) throw this.stopped;
        if (this.managed?.deadline.aborted) throw stop("timeout");
        if (this.managedInFlight) throw stop("request_rejected");
        if (this.consumed[role] >= this.maximum[role]) throw stop("request_limit");
        if (init?.signal?.aborted) throw stop(callerReason());
        if (typeof init?.body !== "string" || init.method !== "POST") throw stop("request_rejected");
        const target = new URL(String(url));
        if (target.protocol !== "https:" || !target.pathname.endsWith("/responses")) throw stop("request_rejected");
        const body = JSON.parse(init.body);
        const keys = new Set(["model", "input", "max_output_tokens", "temperature", "top_p", "text", "store", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "include"]);
        if (!body || Object.keys(body).some(k => !keys.has(k)) || typeof body.model !== "string" ||
            (body.include !== undefined && (!Array.isArray(body.include) || body.include.length > 0))) throw stop("request_rejected");
        if (!Array.isArray(body.input) || body.input.length > 2 ||
            !Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 8192 ||
            body.tools?.length || body.previous_response_id || body.conversation) throw stop("request_rejected");
        // UTF-8 bytes plus framing is an engineering estimate; reconcile usage.
        // Preserve the existing text/schema-only request shape and every limit.
        for (const message of body.input) {
          if (!message || Object.keys(message).some(k => !["role", "content"].includes(k)) ||
              !["system", "developer", "user", "assistant"].includes(message.role) ||
              !(typeof message.content === "string" || (Array.isArray(message.content) &&
                message.content.every((part: { type?: string; text?: unknown }) =>
                  part && Object.keys(part).every(k => ["type", "text"].includes(k)) &&
                  part.type === "input_text" && typeof part.text === "string")))) throw stop("request_rejected");
        }
        if (body.text?.format?.type !== "json_schema" || !body.text.format.schema ||
            typeof body.text.format.schema !== "object") throw stop("request_rejected");
        const requestBytes = Buffer.byteLength(init.body, "utf8");
        try { observation?.bytes(requestBytes); } catch { /* optional */ }
        estimatedInputTokens = requestBytes + 8192;
        maximumOutputTokens = body.max_output_tokens;
        if (estimatedInputTokens > (role === "normal" ? 150_000 : 50_000)) throw stop("input_limit");
      } catch { throw stop("request_rejected"); }
      // Capture this attempt before awaiting; concurrent sends cannot renumber it.
      const attempt = ++this.consumed[role];
      if (this.managed) {
        this.managedInFlight = true;
        try {
          await boundedJournalAck(() => this.managed!.journal.reserve({ ordinal: attempt,
            requestSha256: createHash("sha256").update(init!.body as string).digest("hex"),
            estimatedInputTokens, maximumOutputTokens }), this.managed.deadline);
        } catch { throw stop("unknown"); }
        // An ACK does not make an expired or stopped run dispatchable.
        if (this.stopped) throw this.stopped;
        if (this.managed.deadline.aborted) throw stop("timeout");
        if (init?.signal?.aborted) throw stop(callerReason());
      }
      const deadline = aiOperationDeadline(35_000);
      const signal = AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : []), ...(this.managed ? [this.managed.deadline] : [])]);
      const abortReason = (): PatentWatchStopReason => deadline.aborted || this.managed?.deadline.aborted ? "timeout" : callerReason();
      let abort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abort = () => reject(stop(abortReason()));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      const logUsage = (status: "reconciled" | "reservation_retained", reason: PatentWatchStopReason,
        usage?: { input_tokens: number; output_tokens: number }) => {
        if (diagnostic && !diagnostic.active()) return;
        try {
          console.info("ai_operation_usage", JSON.stringify({ role, attempt, estimatedInputTokens,
            ...(usage ? { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : {}),
            status, ...diagnostic?.usage(reason) }));
        } catch { /* Logging must never stop a successful send. */ }
      };
      try {
        let response: Response;
        try { observation?.dispatch(attempt); } catch { /* optional */ }
        try { response = await Promise.race([transport(url, { ...init, signal, redirect: "error" }), aborted]); }
        catch { throw stop(signal.aborted ? abortReason() : "transport_error"); }
        if (this.stopped) throw this.stopped;
        try { observation?.phase("validating_response"); } catch { /* optional */ }
        if (!response.ok) throw stop("upstream_http_error");
        let result;
        try { observation?.phase("reading_response"); } catch { /* optional */ }
        try { result = await Promise.race([response.clone().json(), aborted]); }
        catch { throw stop(signal.aborted ? abortReason() : "invalid_response"); }
        if (this.stopped) throw this.stopped;
        try { observation?.phase("validating_response"); } catch { /* optional */ }
        const usage = result?.usage;
        if (usage === undefined || usage === null) throw stop("usage_missing");
        if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
            !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) throw stop("usage_invalid");
        if (usage.input_tokens > estimatedInputTokens || usage.input_tokens > (role === "normal" ? 150_000 : 50_000) ||
            usage.output_tokens > maximumOutputTokens) throw stop("usage_limit");
        if (signal.aborted) throw stop(abortReason());
        if (this.managed) {
          try { await boundedJournalAck(() => this.managed!.journal.reconcile({ ordinal: attempt, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens }), this.managed.deadline); }
          catch { throw stop("unknown"); }
          if (this.stopped) throw this.stopped;
          if (signal.aborted) throw stop(abortReason());
        }
        try { observation?.phase("response_validated"); } catch { /* optional */ }
        logUsage("reconciled", "unknown", usage);
        return response;
      } catch {
        const error = stop("unknown");
        logUsage("reservation_retained", error.reason);
        throw error;
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
        this.managedInFlight = false;
      }
    };
  }
}
const active = new AsyncLocalStorage<AiOperationBudget>();
export function withAiOperationBudget<T>(maximum: Record<Role, number>, operation: () => Promise<T>): Promise<T> {
  if (active.getStore()) return operation();
  return active.run(new AiOperationBudget(maximum), operation);
}
/** Only the durable standard watch worker owns this scope, once per logical run. */
export function withManagedWatchBudget<T>(input: { consumed: number; deadlineAt: number; journal: ManagedWatchDispatchJournal }, operation: () => Promise<T>): Promise<T> {
  const remaining = input.deadlineAt - Date.now();
  if (active.getStore() || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 30 * 60_000) throw new AiOperationStopped("timeout");
  const budget = new AiOperationBudget({ normal: 41, fast: 0 }, {
    capability: managedWatchCapability, consumed: input.consumed, deadline: aiOperationDeadline(remaining), journal: input.journal,
  });
  return active.run(budget, async () => {
    try { return await operation(); }
    finally { budget.closeManagedScope(); }
  });
}
export function boundedAzureFetch(role: Role): typeof fetch {
  // Non-budgeted workflows retain their provider behavior.
  return active.getStore()?.wrapFetch(role) ?? globalThis.fetch;
}
