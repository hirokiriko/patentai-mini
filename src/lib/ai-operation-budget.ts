import { AsyncLocalStorage } from "node:async_hooks";

type Role = "normal" | "fast";
export class AiOperationStopped extends Error {
  constructor() { super("ai_operation_stopped"); this.name = "AiOperationStopped"; }
}
export function isAiOperationStopped(error: unknown): boolean {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  for (let n = 0; pending.length && n < 64; n++) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (value instanceof AiOperationStopped || (value instanceof Error && ["AbortError", "TimeoutError"].includes(value.name))) return true;
    const wrapped = value as { cause?: unknown; lastError?: unknown; errors?: unknown[] };
    pending.push(wrapped.cause, wrapped.lastError);
    if (Array.isArray(wrapped.errors)) pending.push(...wrapped.errors.slice(0, 16));
  }
  return false;
}

export class AiOperationBudget {
  private readonly consumed = { normal: 0, fast: 0 };
  private readonly maximum: Readonly<Record<Role, number>>;
  get used(): Readonly<Record<Role, number>> { return Object.freeze({ ...this.consumed }); }
  private stopped = false;
  constructor(maximum: Record<Role, number>) {
    if (!Number.isInteger(maximum.normal) || maximum.normal < 0 || maximum.normal > 12 ||
        !Number.isInteger(maximum.fast) || maximum.fast < 0 || maximum.fast > 8) throw new AiOperationStopped();
    this.maximum = Object.freeze({ ...maximum });
  }
  wrapFetch(role: Role, transport: typeof fetch = globalThis.fetch): typeof fetch {
    return async (url, init) => {
      try {
        if (this.stopped || this.consumed[role] >= this.maximum[role] || init?.signal?.aborted ||
            typeof init?.body !== "string" || init.method !== "POST") throw new AiOperationStopped();
        const target = new URL(String(url));
        if (target.protocol !== "https:" || !target.pathname.endsWith("/responses")) throw new AiOperationStopped();
        const body = JSON.parse(init.body);
        const keys = new Set(["model", "input", "max_output_tokens", "temperature", "top_p", "text", "store", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "include"]);
        if (Object.keys(body).some(k => !keys.has(k)) || typeof body.model !== "string" ||
            (body.include !== undefined && (!Array.isArray(body.include) || body.include.length > 0))) throw new AiOperationStopped();
        if (!body || !Array.isArray(body.input) || body.input.length > 2 ||
            !Number.isInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > 8192 ||
            body.tools?.length || body.previous_response_id || body.conversation) throw new AiOperationStopped();
        // Bound the complete serialized text/schema/system input conservatively.
        // Byte-level BPE cannot have more text tokens than UTF-8 bytes. Reserve
        // another 8192 for framing; images, tools and external context are refused.
        for (const message of body.input) {
          if (!message || Object.keys(message).some(k => !["role", "content"].includes(k)) ||
              !["system", "developer", "user", "assistant"].includes(message.role) ||
              !(typeof message.content === "string" || (Array.isArray(message.content) &&
                message.content.every((part: { type?: string; text?: unknown }) =>
                  part && Object.keys(part).every(k => ["type", "text"].includes(k)) &&
                  part.type === "input_text" && typeof part.text === "string")))) throw new AiOperationStopped();
        }
        if (body.text?.format?.type !== "json_schema" || !body.text.format.schema ||
            typeof body.text.format.schema !== "object") throw new AiOperationStopped();
        if (Buffer.byteLength(init.body, "utf8") + 8192 > (role === "normal" ? 150_000 : 50_000)) throw new AiOperationStopped();
      } catch { this.stopped = true; throw new AiOperationStopped(); }
      // Consume before transport and retain it on failure, timeout or missing usage.
      this.consumed[role]++;
      try { return await transport(url, { ...init, redirect: "error" }); }
      catch (error) {
        if (init?.signal?.aborted || isAiOperationStopped(error)) { this.stopped = true; throw new AiOperationStopped(); }
        throw error;
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
  // Other existing workflows retain their provider behavior; four approved
  // operations explicitly establish the scope before model creation.
  return active.getStore()?.wrapFetch(role) ?? globalThis.fetch;
}
