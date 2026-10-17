import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiOperationBudget, boundedAzureFetch, withAiOperationBudget, withManagedWatchBudget, withPriorArtComparisonBudget } from "./ai-operation-budget";

const url = "https://fictional.invalid/openai/v1/responses";
const init = () => ({ method: "POST", body: JSON.stringify({ model: "fictional", input: [{ role: "user", content: "公開の架空入力" }], max_output_tokens: 64,
  text: { format: { type: "json_schema", schema: { type: "object", properties: {} } } } }) });
const response = (usage: unknown = { input_tokens: 100, output_tokens: 30 }) => Response.json({ usage });

describe("comparison-only time capability", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("allows a response after 35 seconds only within the comparison capability", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { await new Promise(r => setTimeout(r, 40_000)); return response(); });
    vi.stubGlobal("fetch", transport);
    const completed = withPriorArtComparisonBudget(async () => (await boundedAzureFetch("normal")(url, init())).status);
    await vi.advanceTimersByTimeAsync(40_001);
    await expect(completed).resolves.toBe(200); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts a complete 205-second response within the new comparison deadline", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { await new Promise(r => setTimeout(r, 205_000)); return response(); });
    vi.stubGlobal("fetch", transport);
    const pending = withPriorArtComparisonBudget(() => boundedAzureFetch("normal")(url, init()));
    await vi.advanceTimersByTimeAsync(205_001); await expect(pending).resolves.toHaveProperty("status", 200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["ordinary", "managed"])("preserves the 35-second transport limit for %s", async mode => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", transport);
    const reserve = vi.fn(async () => undefined), reconcile = vi.fn(async () => undefined);
    const run = () => boundedAzureFetch("normal")(url, init());
    const pending = mode === "ordinary" ? withAiOperationBudget({ normal: 1, fast: 0 }, run) :
      withManagedWatchBudget({ consumed: 0, deadlineAt: Date.now() + 100_000, journal: { reserve, reconcile } }, run);
    const rejected = expect(pending).rejects.toThrow("ai_operation_stopped");
    await vi.advanceTimersByTimeAsync(35_001); await rejected; expect(transport).toHaveBeenCalledTimes(1);
    if (mode === "managed") { expect(reserve).toHaveBeenCalledTimes(1); expect(reconcile).not.toHaveBeenCalled(); }
  });
  it("stops a comparison send at 210 seconds and retains its stopped state", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined)); vi.stubGlobal("fetch", transport);
    const pending = withPriorArtComparisonBudget(async () => {
      const send = boundedAzureFetch("normal");
      await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
      await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
    });
    await vi.advanceTimersByTimeAsync(210_001); await pending; expect(transport).toHaveBeenCalledTimes(1);
  });
  it("shares the absolute 230 seconds across requests instead of resetting it", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { await new Promise(r => setTimeout(r, 150_000)); return response(); });
    vi.stubGlobal("fetch", transport);
    const pending = withPriorArtComparisonBudget(async () => { const send = boundedAzureFetch("normal"); await send(url, init()); await send(url, init()); });
    const rejected = expect(pending).rejects.toThrow("ai_operation_stopped");
    await vi.advanceTimersByTimeAsync(230_001); await rejected; expect(transport).toHaveBeenCalledTimes(2);
  });
  it("applies the send deadline to a stalled response body too", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ start() {} })));
    vi.stubGlobal("fetch", transport);
    const pending = withPriorArtComparisonBudget(() => boundedAzureFetch("normal")(url, init()));
    const rejected = expect(pending).rejects.toThrow("ai_operation_stopped");
    await vi.advanceTimersByTimeAsync(210_001); await rejected; expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps normal3/fast0 and never retries unknown usage", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withPriorArtComparisonBudget(async () => {
      const send = boundedAzureFetch("normal"); for (let n = 0; n < 3; n++) await send(url, init());
      await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
    });
    expect(transport).toHaveBeenCalledTimes(3);
    transport.mockClear(); transport.mockImplementation(async () => response(null));
    await withPriorArtComparisonBudget(async () => {
      const send = boundedAzureFetch("normal"); await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
      await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
    });
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockClear();
    await withPriorArtComparisonBudget(async () => { await expect(boundedAzureFetch("fast")(url, init())).rejects.toThrow("ai_operation_stopped"); });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects nested scopes and forged capabilities without broadening another budget", async () => {
    await withAiOperationBudget({ normal: 1, fast: 0 }, async () => { expect(() => withPriorArtComparisonBudget(async () => undefined)).toThrow("ai_operation_stopped"); });
    await withPriorArtComparisonBudget(async () => {
      expect(() => withPriorArtComparisonBudget(async () => undefined)).toThrow("ai_operation_stopped");
      expect(() => withAiOperationBudget({ normal: 12, fast: 8 }, async () => undefined)).toThrow("ai_operation_stopped");
    });
    expect(() => new AiOperationBudget({ normal: 3, fast: 0 }, undefined,
      { capability: Symbol("prior_art_comparison"), deadline: new AbortController().signal } as never)).toThrow("ai_operation_stopped");
    expect(() => withPriorArtComparisonBudget(async () => undefined, 12 as 3)).toThrow("ai_operation_stopped");
  });
  it("refuses a captured fetch after scope exit even with unused calls", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    let captured: typeof fetch = fetch;
    await withPriorArtComparisonBudget(async () => { captured = boundedAzureFetch("normal"); });
    await expect(captured(url, init())).rejects.toThrow("ai_operation_stopped"); expect(transport).not.toHaveBeenCalled();
  });
  it("aborts an unfinished send when its comparison scope exits", async () => {
    let signal: AbortSignal | undefined, pending: Promise<Response> | undefined;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined; return new Promise(() => undefined);
    });
    vi.stubGlobal("fetch", transport);
    let rejected: Promise<void> | undefined;
    await withPriorArtComparisonBudget(async () => {
      pending = boundedAzureFetch("normal")(url, init());
      rejected = expect(pending).rejects.toThrow("ai_operation_stopped");
      expect(signal?.aborted).toBe(false);
    });
    await rejected; expect(signal?.aborted).toBe(true); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("limits a probe scope to one send", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withPriorArtComparisonBudget(async () => {
      const send = boundedAzureFetch("normal"); await send(url, init());
      await expect(send(url, init())).rejects.toThrow("ai_operation_stopped");
    }, 1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["gpt-5.4", "gpt-5.4-2026-03-05", "patentai-gpt54"])("allows reasoning output only for the comparison capability on %s", async model => {
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response({input_tokens:100,output_tokens:32768}));vi.stubGlobal("fetch",transport);
    const request={...init(),body:JSON.stringify({...JSON.parse(init().body),model,reasoning:{effort:"medium"},max_output_tokens:32768})};
    await expect(withPriorArtComparisonBudget(()=>boundedAzureFetch("normal")(url,request))).resolves.toHaveProperty("status",200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["ordinary", "managed", "unknown", "mini", "low", "high", "missing", "excess", "fast"])("keeps the larger output unavailable for %s", async mode => {
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response());vi.stubGlobal("fetch",transport);
    const body={...JSON.parse(init().body),model:mode==="unknown"?"custom-alias":mode==="mini"?"gpt-5.4-mini":"patentai-gpt54",reasoning:mode==="missing"?undefined:{effort:mode==="low"?"low":mode==="high"?"high":"medium"},max_output_tokens:mode==="excess"?32769:8193};
    const send=()=>boundedAzureFetch(mode==="fast"?"fast":"normal")(url,{...init(),body:JSON.stringify(body)});
    const run=()=>mode==="ordinary"?withAiOperationBudget({normal:1,fast:0},send):mode==="managed"?withManagedWatchBudget({consumed:0,deadlineAt:Date.now()+100000,journal:{reserve:vi.fn(async()=>undefined),reconcile:vi.fn(async()=>undefined)}},send):withPriorArtComparisonBudget(send);
    await expect(run()).rejects.toThrow("ai_operation_stopped");expect(transport).not.toHaveBeenCalled();
  });
  it("stops without retry when usage exceeds the reasoning request cap", async () => {
    const transport=vi.fn<typeof fetch>().mockImplementation(async()=>response({input_tokens:100,output_tokens:32769}));vi.stubGlobal("fetch",transport);
    const request={...init(),body:JSON.stringify({...JSON.parse(init().body),model:"patentai-gpt54",reasoning:{effort:"medium"},max_output_tokens:32768})};
    await withPriorArtComparisonBudget(async()=>{
      const send=boundedAzureFetch("normal");await expect(send(url,request)).rejects.toThrow("ai_operation_stopped");
      await expect(send(url,request)).rejects.toThrow("ai_operation_stopped");
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects nesting with a managed scope in both directions", async () => {
    const managed = { consumed: 0, deadlineAt: Date.now() + 100_000,
      journal: { reserve: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) } };
    await withManagedWatchBudget(managed, async () => {
      expect(() => withPriorArtComparisonBudget(async () => undefined)).toThrow("ai_operation_stopped");
    });
    await withPriorArtComparisonBudget(async () => {
      expect(() => withManagedWatchBudget(managed, async () => undefined)).toThrow("ai_operation_stopped");
    });
  });
});
