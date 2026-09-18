import { AsyncLocalStorage } from "node:async_hooks";
import { capturePatentWatchDiagnostic } from "./patent-watch/diagnostic-context";
import { isPatentWatchStopReason, type PatentWatchStopReason } from "./patent-watch/diagnostic";

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
  constructor(maximum: Record<Role, number>) {
    if (!Number.isInteger(maximum.normal) || maximum.normal < 0 || maximum.normal > 12 ||
        !Number.isInteger(maximum.fast) || maximum.fast < 0 || maximum.fast > 8) throw new AiOperationStopped();
    this.maximum = Object.freeze({ ...maximum });
  }
  wrapFetch(role: Role, transport: typeof fetch = globalThis.fetch): typeof fetch {
    const boundDiagnostic = capturePatentWatchDiagnostic();
    return async (url, init) => {
      const diagnostic = boundDiagnostic ?? capturePatentWatchDiagnostic();
      const stop = (reason: PatentWatchStopReason): AiOperationStopped => {
        this.stopped ??= new AiOperationStopped(reason);
        diagnostic?.stop(this.stopped.reason);
        return this.stopped;
      };
      const callerReason = (): PatentWatchStopReason =>
        init?.signal && deadlines.has(init.signal) ? "timeout" : "aborted";
      let estimatedInputTokens = 0;
      let maximumOutputTokens = 0;
      try {
        if (this.stopped) throw this.stopped;
        if (diagnostic && !diagnostic.active()) throw stop("unknown");
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
        estimatedInputTokens = Buffer.byteLength(init.body, "utf8") + 8192;
        maximumOutputTokens = body.max_output_tokens;
        if (estimatedInputTokens > (role === "normal" ? 150_000 : 50_000)) throw stop("input_limit");
      } catch { throw stop("request_rejected"); }
      // Capture this attempt before awaiting; concurrent sends cannot renumber it.
      const attempt = ++this.consumed[role];
      const deadline = aiOperationDeadline(35_000);
      const signal = AbortSignal.any([deadline, ...(init?.signal ? [init.signal] : [])]);
      const abortReason = (): PatentWatchStopReason => deadline.aborted ? "timeout" : callerReason();
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
        try { response = await Promise.race([transport(url, { ...init, signal, redirect: "error" }), aborted]); }
        catch { throw stop(signal.aborted ? abortReason() : "transport_error"); }
        if (!response.ok) throw stop("upstream_http_error");
        let result;
        try { result = await Promise.race([response.clone().json(), aborted]); }
        catch { throw stop(signal.aborted ? abortReason() : "invalid_response"); }
        const usage = result?.usage;
        if (usage === undefined || usage === null) throw stop("usage_missing");
        if (!Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 ||
            !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) throw stop("usage_invalid");
        if (usage.input_tokens > estimatedInputTokens || usage.input_tokens > (role === "normal" ? 150_000 : 50_000) ||
            usage.output_tokens > maximumOutputTokens) throw stop("usage_limit");
        if (signal.aborted) throw stop(abortReason());
        logUsage("reconciled", "unknown", usage);
        return response;
      } catch {
        const error = stop("unknown");
        logUsage("reservation_retained", error.reason);
        throw error;
      } finally {
        if (abort) signal.removeEventListener("abort", abort);
      }
    };
  }
}
const active = new AsyncLocalStorage<AiOperationBudget>();
export function withAiOperationBudget<T>(maximum: Record<Role, number>, operation: () => Promise<T>): Promise<T> {
  if (active.getStore()) return operation();
  return active.run(new AiOperationBudget(maximum), operation);
}
export function boundedAzureFetch(role: Role): typeof fetch {
  // Non-budgeted workflows retain their provider behavior.
  return active.getStore()?.wrapFetch(role) ?? globalThis.fetch;
}
