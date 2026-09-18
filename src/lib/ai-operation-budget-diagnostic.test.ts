import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiOperationBudget, AiOperationStopped, aiOperationDeadline, aiOperationStopReason,
  boundedAzureFetch, withAiOperationBudget } from "./ai-operation-budget";
import { currentPatentWatchDiagnostic, withPatentWatchDiagnostic, withPatentWatchStage } from "./patent-watch/diagnostic-context";

const SECRET = "FICTIONAL_PRIVATE_GUARD_SENTINEL";
const url = "https://example.invalid/openai/v1/responses";
const request = (overrides = {}): RequestInit => ({ method: "POST", body: JSON.stringify({
  model: "fictional", input: [{ role: "user", content: SECRET }], max_output_tokens: 8192,
  text: { format: { type: "json_schema", schema: { type: "object" } } }, ...overrides,
}) });
const valid = () => Response.json({ usage: { input_tokens: 20, output_tokens: 10 } });
function observe(operation: () => Promise<unknown>) {
  return withPatentWatchDiagnostic(async () => {
    try { await withPatentWatchStage("detail", operation); }
    catch { return { response: Response.json(currentPatentWatchDiagnostic()), code: "watch_ai_stopped" }; }
    return { response: Response.json(currentPatentWatchDiagnostic()), code: "completed" };
  });
}
const logs = (name: string) => vi.mocked(console.info).mock.calls.filter(call => call[0] === name).map(call => JSON.parse(String(call[1])));

describe("fixed guard reasons and execution lifetime", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it.each([
    ["request_rejected", () => valid(), { method: "POST", body: "{" }, 1, 0],
    ["input_limit", () => valid(), request({ input: [{ role: "user", content: "文".repeat(50_000) }] }), 1, 0],
    ["request_limit", () => valid(), request(), 0, 0],
    ["upstream_http_error", () => new Response(SECRET, { status: 401, statusText: SECRET }), request(), 1, 1],
    ["transport_error", () => { throw new Error(SECRET); }, request(), 1, 1],
    ["invalid_response", () => new Response("{" + SECRET), request(), 1, 1],
    ["usage_missing", () => Response.json({ body: SECRET }), request(), 1, 1],
    ["usage_missing", () => Response.json({ usage: null }), request(), 1, 1],
    ["usage_invalid", () => Response.json({ usage: {} }), request(), 1, 1],
    ["usage_invalid", () => Response.json({ usage: { input_tokens: -1, output_tokens: 2 } }), request(), 1, 1],
    ["usage_invalid", () => Response.json({ usage: { input_tokens: 1.5, output_tokens: 2 } }), request(), 1, 1],
    ["usage_invalid", () => Response.json({ usage: { input_tokens: "1", output_tokens: 2 } }), request(), 1, 1],
    ["usage_limit", () => Response.json({ usage: { input_tokens: 150001, output_tokens: 2 } }), request(), 1, 1],
    ["usage_limit", () => Response.json({ usage: { input_tokens: 20, output_tokens: 8193 } }), request(), 1, 1],
  ] as const)("classifies %s without retaining provider data %#", async (reason, response, input, maximum, sends) => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response());
    const budget = new AiOperationBudget({ normal: maximum, fast: 1 });
    const result = await observe(async () => {
      const guarded = budget.wrapFetch("normal", transport);
      const first = await guarded(url, input).catch(error => error);
      expect(first).toMatchObject({ reason, message: "ai_operation_stopped" });
      expect(first.cause).toBeUndefined();
      // Further calls preserve the first reason and cannot send again.
      await expect(budget.wrapFetch("fast", transport)(url, request())).rejects.toBe(first);
      throw first;
    });
    expect(await result.json()).toMatchObject({ stage: "detail", reason });
    expect(transport).toHaveBeenCalledTimes(sends);
    expect(logs("patent_watch_diagnostic")).toHaveLength(1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(SECRET);
  });
  it.each(["fetch", "body", "caller-deadline", "caller-abort", "already-aborted"])("uses signal facts for %s", async phase => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException(SECRET, "TimeoutError")), ms);
      return controller.signal;
    });
    const caller = new AbortController();
    if (phase === "already-aborted") caller.abort(new Error(SECRET));
    const callerSignal = phase === "caller-deadline" ? aiOperationDeadline(100) : caller.signal;
    if (phase === "caller-abort") setTimeout(() => caller.abort(new Error(SECRET)), 100);
    let late: ((value: Response) => void) | undefined;
    const transport = vi.fn<typeof fetch>().mockImplementation(() => phase === "body"
      ? Promise.resolve({ ok: true, clone: () => ({ json: () => new Promise(() => {}) }) } as Response)
      : new Promise(resolve => { late = resolve; }));
    const response = observe(() => new AiOperationBudget({ normal: 1, fast: 0 }).wrapFetch("normal", transport)(url, { ...request(), signal: callerSignal }));
    await vi.advanceTimersByTimeAsync(35_000);
    const expected = phase === "caller-abort" || phase === "already-aborted" ? "aborted" : "timeout";
    expect(await (await response).json()).toMatchObject({ stage: "detail", reason: expected });
    if (late) late(valid());
    await vi.advanceTimersByTimeAsync(35_000);
    expect(logs("patent_watch_diagnostic")).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(phase === "already-aborted" ? 0 : 1);
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(SECRET);
  });
  it("keeps wrapped reasons, handles cycles and never interprets raw messages", () => {
    const stopped = new AiOperationStopped("usage_limit");
    const wrapper = Object.assign(new Error(SECRET), { cause: { errors: [stopped] } });
    Object.assign(wrapper, { lastError: wrapper });
    expect(aiOperationStopReason(wrapper)).toBe("usage_limit");
    expect(aiOperationStopReason(new Error("timeout " + SECRET))).toBeNull();
    expect(aiOperationStopReason(new DOMException(SECRET, "TimeoutError"))).toBe("aborted");
    expect(aiOperationStopReason(new AiOperationStopped())).toBe("unknown");
    const getter = vi.fn(() => { throw new Error(SECRET); });
    expect(aiOperationStopReason(Object.defineProperty({}, "cause", { get: getter }))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    expect(aiOperationStopReason(Object.defineProperty(new Error(), "name", { get: getter }))).toBeNull();
    expect(aiOperationStopReason(Object.defineProperty(Object.create(AiOperationStopped.prototype), "reason", { get: getter }))).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    let deep: unknown = stopped;
    for (let n = 0; n < 70; n++) deep = { cause: deep };
    expect(aiOperationStopReason(deep)).toBeNull();
  });
  it("retains nested consumption and never sends from a finished execution's callback", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => valid());
    vi.stubGlobal("fetch", transport);
    let late!: () => Promise<Response>;
    const first = await observe(() => withAiOperationBudget({ normal: 1, fast: 0 }, async () => {
      const guarded = boundedAzureFetch("normal"); late = () => guarded(url, request());
      await guarded(url, request());
      return withAiOperationBudget({ normal: 3, fast: 0 }, () => boundedAzureFetch("normal")(url, request()));
    }));
    expect(await first.json()).toMatchObject({ reason: "request_limit" });
    const second = await observe(async () => {
      await expect(late()).rejects.toMatchObject({ reason: "unknown" });
      expect(currentPatentWatchDiagnostic()).toMatchObject({ stage: "unknown", reason: "unknown" });
    });
    expect(await second.json()).toMatchObject({ reason: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(logs("patent_watch_diagnostic")).toHaveLength(2);
    expect(logs("ai_operation_usage")).toHaveLength(1);
  });
  it("blocks a delayed callback even after a successful execution", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => valid());
    let late!: () => Promise<Response>;
    await observe(async () => {
      const guard = new AiOperationBudget({ normal: 3, fast: 0 }).wrapFetch("normal", transport);
      late = () => guard(url, request()); await guard(url, request());
    });
    await expect(late()).rejects.toMatchObject({ reason: "unknown" });
    expect(transport).toHaveBeenCalledTimes(1); expect(logs("patent_watch_diagnostic")).toHaveLength(1);
  });
  it("captures concurrent attempt numbers at send time", async () => {
    const pending: Array<(value: Response) => void> = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => pending.push(resolve)));
    const budget = new AiOperationBudget({ normal: 2, fast: 0 });
    await observe(async () => {
      const one = budget.wrapFetch("normal", transport)(url, request());
      const two = budget.wrapFetch("normal", transport)(url, request());
      pending[1](valid()); await two; pending[0](valid()); await one;
    });
    expect(logs("ai_operation_usage").map(row => row.attempt)).toEqual([2, 1]);
  });
  it("keeps non-watch usage fields and ignores logging failure", async () => {
    const guard = new AiOperationBudget({ normal: 2, fast: 0 }).wrapFetch("normal", async () => valid());
    await guard(url, request());
    expect(Object.keys(logs("ai_operation_usage")[0]).sort()).toEqual([
      "attempt", "estimatedInputTokens", "inputTokens", "outputTokens", "role", "status",
    ]);
    vi.mocked(console.info).mockImplementationOnce(() => { throw new Error(SECRET); });
    await expect(guard(url, request())).resolves.toBeInstanceOf(Response);
    vi.mocked(console.info).mockImplementationOnce(() => { throw new Error(SECRET); });
    await expect(observe(async () => undefined)).resolves.toBeInstanceOf(Response);
  });
});
