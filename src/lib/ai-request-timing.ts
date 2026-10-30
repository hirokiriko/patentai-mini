import { AsyncLocalStorage } from "node:async_hooks";

export type AiRequestTimingPhase = "request_enter" | "reservation_begin" | "reservation_ack" |
  "request_deadline_armed" | "transport_begin" | "headers_received" | "body_begin" | "body_complete" |
  "abort" | "terminal";
/** "caller" can itself be a composite deadline; it does not mean user cancellation. */
export type AiRequestAbortSource = "request" | "caller" | "comparison" | "managed";
export type AiRequestTimingEvent = Readonly<{
  attempt: number;
  phase: AiRequestTimingPhase;
  elapsedMs: number;
  abortSource: AiRequestAbortSource | null;
}>;
type Scope = { active: boolean; observe: (event: AiRequestTimingEvent) => unknown };
const timing = new AsyncLocalStorage<Scope>();
// A private process preload and a separately bundled server share this optional
// observer. No environment variable or public route installs it.
const processKey = Symbol.for("patentai.ai-request-timing.v1");
type TimingGlobal = typeof globalThis & { [processKey]?: Scope };

export function installAiRequestTimingObserver(observe: Scope["observe"]): () => void {
  const target = globalThis as TimingGlobal;
  if (target[processKey]?.active) throw new Error("ai_request_timing_already_installed");
  const scope: Scope = { active: true, observe };
  target[processKey] = scope;
  return () => {
    scope.active = false;
    if (target[processKey] === scope) delete target[processKey];
  };
}

/** An explicitly installed private observer receives only bounded numeric timing
 * and fixed labels. It never receives a request, URL, headers, body or exception. */
export async function withAiRequestTiming<T>(observe: Scope["observe"], operation: () => Promise<T>): Promise<T> {
  const scope: Scope = { active: true, observe };
  return timing.run(scope, async () => {
    try { return await operation(); }
    finally { scope.active = false; }
  });
}

export function captureAiRequestTiming() {
  const scope = timing.getStore() ?? (globalThis as TimingGlobal)[processKey];
  if (!scope) return undefined;
  return (attempt: number) => {
    const started = performance.now();
    let closed = false, count = 0, firstAbort: AiRequestAbortSource | null = null;
    const cleanup: (() => void)[] = [];
    const emit = (phase: AiRequestTimingPhase) => {
      if (closed || !scope.active || count >= 32 || !Number.isSafeInteger(attempt) || attempt < 1) return;
      count++;
      const elapsedMs = Math.min(86_400_000, Math.max(0, Math.floor(performance.now() - started)));
      try { void Promise.resolve(scope.observe(Object.freeze({ attempt, phase, elapsedMs, abortSource: firstAbort }))).catch(() => {}); }
      catch { /* Optional observation cannot change a request's outcome. */ }
    };
    const watch = (signal: AbortSignal | undefined | null, source: AiRequestAbortSource) => {
      if (!signal || closed || !scope.active) return;
      const aborted = () => {
        if (closed || !scope.active || firstAbort !== null) return;
        firstAbort = source;
        emit("abort");
      };
      signal.addEventListener("abort", aborted, { once: true });
      cleanup.push(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    };
    emit("request_enter");
    return { emit, watch, close() {
      if (closed) return;
      emit("terminal");
      closed = true;
      for (const remove of cleanup) remove();
    } };
  };
}
