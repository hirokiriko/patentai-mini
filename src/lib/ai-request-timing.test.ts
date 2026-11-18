import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiOperationBudget, boundedAzureFetch, withManagedWatchBudget, withPriorArtClaimComparisonBudget } from "./ai-operation-budget";
import { captureAiRequestTiming, installAiRequestTimingObserver, withAiRequestTiming, type AiRequestTimingEvent } from "./ai-request-timing";

const url = "https://fictional.invalid/openai/v1/responses";
const init = { method: "POST", body: JSON.stringify({ model: "patentai-gpt54", input: [{ role: "user", content: JSON.stringify({ task: "extract_source_propositions", secret: "fictional-private-source" }) }], reasoning: { effort: "high" }, max_output_tokens: 64, text: { format: { type: "json_schema", schema: { type: "object" } } } }) };
const response = () => Response.json({ usage: { input_tokens: 1, output_tokens: 1 } });

describe("private bounded request timing (fictional transport)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); });

  it.each(["headers", "body"])("distinguishes a source deadline while waiting for %s", async waiting => {
    const events: AiRequestTimingEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => waiting === "headers" ? new Promise<Response>(() => {}) : new Response(new ReadableStream())));
    await withAiRequestTiming(event => events.push(event), () => withPriorArtClaimComparisonBudget(1, async () => {
      const pending = boundedAzureFetch("normal")(url, init);
      const failed = expect(pending).rejects.toThrow("ai_operation_stopped");
      await vi.advanceTimersByTimeAsync(420_000); await failed;
    }));
    const phases = events.map(event => event.phase);
    expect(phases.includes("headers_received")).toBe(waiting === "body");
    expect(phases.includes("body_begin")).toBe(waiting === "body");
    expect(phases).not.toContain("body_complete");
    expect(events.find(event => event.phase === "abort")?.abortSource).toBe("request");
    expect(phases.at(-1)).toBe("terminal");
    expect(JSON.stringify(events)).not.toMatch(/fictional|https|input_tokens|secret/);
    expect(events.find(event => event.phase === "stopped")?.stopReason).toBe("timeout");
    for (const event of events) expect(Object.keys(event).sort()).toEqual(["abortSource", "attempt", "elapsedMs", "phase", ...(event.phase === "stopped" ? ["stopReason"] : [])]);
  });

  it("records reservation wait separately before arming the transport deadline", async () => {
    const events: AiRequestTimingEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => response()));
    const run = withAiRequestTiming(event => events.push(event), () => withManagedWatchBudget({
      consumed: 0, deadlineAt: Date.now() + 100_000,
      journal: { reserve: () => new Promise(resolve => setTimeout(resolve, 1500)), reconcile: async () => {} },
    }, async () => { await boundedAzureFetch("normal")(url, init); }));
    await vi.advanceTimersByTimeAsync(1500); await run;
    expect(events.map(event => event.phase)).toEqual(["request_enter", "reservation_begin", "reservation_ack", "request_deadline_armed", "transport_begin", "headers_received", "body_begin", "body_complete", "terminal"]);
    expect(events[2].elapsedMs - events[1].elapsedMs).toBe(1500);
  });

  it.each(["transport_error", "usage_missing", "usage_invalid"] as const)("records %s without releasing the unknown send or retrying", async reason => {
    const events: AiRequestTimingEvent[] = [], budget = new AiOperationBudget({ normal: 3, fast: 3 });
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (reason === "transport_error") throw new Error("PRIVATE_TRANSPORT_ERROR");
      return Response.json(reason === "usage_missing" ? {} : { usage: { input_tokens: -1, output_tokens: 1 } });
    });
    await withAiRequestTiming(event => events.push(event), async () => {
      await expect(budget.wrapFetch("normal", transport)(url, init)).rejects.toThrow("ai_operation_stopped");
      await expect(budget.wrapFetch("fast", transport)(url, init)).rejects.toThrow("ai_operation_stopped");
    });
    expect(events.find(event => event.phase === "stopped")?.stopReason).toBe(reason);
    expect(events.some(event => event.phase === "body_complete")).toBe(reason !== "transport_error");
    expect(budget.used).toEqual({ normal: 1, fast: 0 });
    expect(transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|fictional|input_tokens/);
  });

  it.each(["caller", "comparison", "managed"] as const)("records the first observed %s signal without exposing its reason", async source => {
    const events: AiRequestTimingEvent[] = [], controller = new AbortController();
    await withAiRequestTiming(event => events.push(event), async () => {
      const trace = captureAiRequestTiming()!(1);
      trace.watch(controller.signal, source);
      controller.abort(new Error("fictional-private-reason"));
      trace.watch(AbortSignal.abort(), "request");
      trace.close();
    });
    expect(events.filter(event => event.phase === "abort")).toHaveLength(1);
    expect(events.at(-1)?.abortSource).toBe(source);
    expect(JSON.stringify(events)).not.toContain("fictional-private-reason");
  });

  it("ignores late transport completion and a captured observer after its scope closes", async () => {
    const events: AiRequestTimingEvent[] = [];
    let complete!: (value: Response) => void, captured: ReturnType<typeof captureAiRequestTiming>;
    await withAiRequestTiming(event => events.push(event), async () => {
      captured = captureAiRequestTiming();
      const send = new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", () => new Promise(resolve => { complete = resolve; }));
      const result = expect(send(url, init)).rejects.toThrow("ai_operation_stopped");
      await vi.advanceTimersByTimeAsync(35_000); await result;
    });
    const before = JSON.stringify(events);
    complete(response()); await Promise.resolve();
    captured!(2).emit("headers_received");
    expect(JSON.stringify(events)).toBe(before);
  });

  it.each([false, true])("keeps optional observer exceptions from changing a successful request, async=%s", async asynchronous => {
    const transport = vi.fn(async () => response());
    await withAiRequestTiming(() => { if (asynchronous) return Promise.reject(new Error("observer failed")); throw new Error("observer failed"); }, async () => {
      await expect(new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", transport)(url, init)).resolves.toHaveProperty("status", 200);
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("shares only an explicitly installed process observer across server bundles and closes captured callbacks", async () => {
    const events: AiRequestTimingEvent[] = [];
    const dispose = installAiRequestTimingObserver(event => events.push(event));
    try {
      expect(() => installAiRequestTimingObserver(() => {})).toThrow("already_installed");
      vi.resetModules();
      const otherBundle = await import("./ai-request-timing");
      const trace = otherBundle.captureAiRequestTiming()!(1);
      expect(events).toHaveLength(1);
      dispose(); trace.emit("headers_received"); trace.close();
      expect(events).toHaveLength(1);
      expect(otherBundle.captureAiRequestTiming()).toBeUndefined();
    } finally { dispose(); }
  });

  it("labels an earlier composite caller deadline without inventing its inner cause", async () => {
    const events: AiRequestTimingEvent[] = [], caller = new AbortController();
    const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await withAiRequestTiming(event => events.push(event), async () => {
      const send = new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", transport);
      const done = expect(send(url, { ...init, signal: AbortSignal.any([caller.signal]) })).rejects.toThrow("ai_operation_stopped");
      caller.abort(); await done;
    });
    expect(events.find(event => event.phase === "abort")?.abortSource).toBe("caller");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("forwards the same bounded event to an existing private observer only when explicitly requested", async () => {
    const outer: AiRequestTimingEvent[] = [], inner: AiRequestTimingEvent[] = [];
    const dispose = installAiRequestTimingObserver(event => outer.push(event));
    try {
      await withAiRequestTiming(event => inner.push(event), async () => {
        const trace = captureAiRequestTiming()!(1);
        trace.stop("usage_missing"); trace.stop("timeout"); trace.close();
        trace.stop("unknown");
      }, true);
      expect(outer).toEqual(inner);
      expect(outer.filter(event => event.phase === "stopped")).toEqual([expect.objectContaining({ stopReason: "usage_missing" })]);
      const before = outer.length;
      await withAiRequestTiming(() => {}, async () => { captureAiRequestTiming()!(2).close(); });
      expect(outer).toHaveLength(before);
    } finally { dispose(); }
  });
  it("does not forward to a parent disposed by the local observer", async () => {
    const outer = vi.fn(), dispose = installAiRequestTimingObserver(outer);
    try {
      await withAiRequestTiming(() => dispose(), async () => { captureAiRequestTiming()!(1).close(); }, true);
      expect(outer).not.toHaveBeenCalled();
    } finally { dispose(); }
  });
});
