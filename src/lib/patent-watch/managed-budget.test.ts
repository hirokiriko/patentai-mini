import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { generateObject } from "ai";
import { z } from "zod";
import { AiOperationBudget, boundedAzureFetch, withAiOperationBudget, withManagedWatchBudget, type ManagedWatchDispatchJournal } from "../ai-operation-budget";
const url = "https://example.invalid/openai/responses";
const request = () => ({ method: "POST", body: JSON.stringify({ model: "fictional", input: [{ role: "user", content: "fictional" }],
  max_output_tokens: 8192, text: { format: { type: "json_schema", schema: { type: "object" } } } }) });
const response = () => Response.json({ usage: { input_tokens: 20, output_tokens: 10 } });
const journal = (): ManagedWatchDispatchJournal => ({ reserve: vi.fn(async () => undefined), reconcile: vi.fn(async () => undefined) });
const options = (j = journal(), consumed = 0) => ({ journal: j, consumed, deadlineAt: Date.now() + 30 * 60_000 });
describe("durable managed-watch budget boundary", () => {
  beforeEach(() => vi.spyOn(console, "info").mockImplementation(() => undefined));
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
  it("cannot send through a captured transport after its logical run scope ends", async () => {
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    const captured = await withManagedWatchBudget(options(), async () => boundedAzureFetch("normal"));
    await expect(captured(url, request())).rejects.toThrow(); expect(transport).not.toHaveBeenCalled();
  });
  it("honors caller abort while awaiting a reservation acknowledgement", async () => {
    const controller = new AbortController(), j = journal();
    vi.mocked(j.reserve).mockImplementation(async () => { controller.abort(); });
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), async () => {
      await expect(boundedAzureFetch("normal")(url, { ...request(), signal: controller.signal })).rejects.toThrow();
    });
    expect(j.reserve).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
  });
  it("a concurrent guard stop also fails the earlier in-flight request", async () => {
    let release!: () => void;
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { release = () => resolve(response()); }));
    vi.stubGlobal("fetch", transport); const j = journal();
    await withManagedWatchBudget(options(j), async () => {
      const first = expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      release(); await first;
    });
    expect(j.reconcile).not.toHaveBeenCalled(); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("dispatches exactly the request snapshot that was validated and journaled", async () => {
    const init = { ...request(), headers: new Headers({ "x-fictional": "before" }) }, target = new URL(url);
    const original = init.body, j = journal();
    vi.mocked(j.reserve).mockImplementation(async () => {
      init.body = JSON.stringify({ max_output_tokens: 999999, private: "FICTIONAL-PRIVATE-SENTINEL" });
      init.headers.set("x-fictional", "after"); target.hostname = "changed.invalid";
    });
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), () => boundedAzureFetch("normal")(target, init));
    expect(transport.mock.calls[0][0]).toBe(url);
    expect(transport.mock.calls[0][1]?.body).toBe(original);
    expect(new Headers(transport.mock.calls[0][1]?.headers).get("x-fictional")).toBe("before");
  });
  it("keeps general budgets limited and isolates the normal41 fast0 contract", async () => {
    expect(() => new AiOperationBudget({ normal: 41, fast: 0 })).toThrow();
    const j = journal(); const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), async () => {
      for (let n = 0; n < 41; n++) await boundedAzureFetch("normal")(url, request());
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      await expect(boundedAzureFetch("fast")(url, request())).rejects.toThrow();
    });
    expect(transport).toHaveBeenCalledTimes(41); expect(j.reserve).toHaveBeenCalledTimes(41); expect(j.reconcile).toHaveBeenCalledTimes(41);
    expect(vi.mocked(j.reserve).mock.calls.map(([r]) => r.ordinal)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1));
  });
  it("retains consumed attempts after restart instead of creating a new allowance", async () => {
    const j = journal(); const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j, 40), async () => {
      await boundedAzureFetch("normal")(url, request());
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
    });
    expect(transport).toHaveBeenCalledTimes(1); expect(j.reserve).toHaveBeenCalledWith(expect.objectContaining({ ordinal: 41 }));
  });
  it("does not reset a run budget in nested existing analysis scopes", async () => {
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(journal(), 40), () => withAiOperationBudget({ normal: 3, fast: 0 }, async () => {
      await boundedAzureFetch("normal")(url, request());
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
    }));
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("requires durable reservation ACK before dispatch and stops all remaining sends on failure", async () => {
    const j = journal(); vi.mocked(j.reserve).mockRejectedValue(new Error("FICTIONAL-PRIVATE-JOURNAL-ERROR"));
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), async () => {
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow("ai_operation_stopped");
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow("ai_operation_stopped");
    });
    expect(j.reserve).toHaveBeenCalledTimes(1); expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain("FICTIONAL-PRIVATE-JOURNAL-ERROR");
  });
  it("keeps a result with unconfirmed reconciliation from becoming successful", async () => {
    const j = journal(); vi.mocked(j.reconcile).mockRejectedValue(new Error("FICTIONAL-PRIVATE-JOURNAL-ERROR"));
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => response()); vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), async () => {
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
    });
    expect(transport).toHaveBeenCalledTimes(1); expect(j.reserve).toHaveBeenCalledTimes(1);
  });
  it("stops at the persisted run deadline and sends nothing further even after late response", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
    const j = journal(); const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Promise(resolve => setTimeout(() => resolve(response()), 10_000)));
    vi.stubGlobal("fetch", transport);
    const done = withManagedWatchBudget({ ...options(j), deadlineAt: Date.now() + 1000 }, async () => {
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
    });
    await vi.advanceTimersByTimeAsync(10_001); await done;
    expect(transport).toHaveBeenCalledTimes(1); expect(j.reconcile).not.toHaveBeenCalled();
  });
  it("does not wait indefinitely for an ambiguous reservation ACK or dispatch after it arrives", async () => {
    vi.useFakeTimers(); const j = journal();
    vi.mocked(j.reserve).mockImplementation(() => new Promise(resolve => setTimeout(resolve, 30_000)));
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", transport);
    const done = withManagedWatchBudget(options(j), async () => {
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
      await expect(boundedAzureFetch("normal")(url, request())).rejects.toThrow();
    });
    await vi.advanceTimersByTimeAsync(30_001); await done;
    expect(transport).not.toHaveBeenCalled(); expect(j.reserve).toHaveBeenCalledTimes(1);
  });
  it("journals the actual installed Azure SDK request and usage without content fields", async () => {
    const j = journal(); const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10 } }));
    vi.stubGlobal("fetch", transport);
    await withManagedWatchBudget(options(j), async () => {
      const azure = createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional", apiVersion: "v1", fetch: boundedAzureFetch("normal") });
      const r = await generateObject({ model: azure("fictional"), schema: z.object({ ok: z.boolean() }), prompt: "FICTIONAL-PUBLIC-CLAIM", maxRetries: 0, maxOutputTokens: 8192 });
      expect(r.object.ok).toBe(true);
    });
    expect(j.reserve).toHaveBeenCalledWith({ ordinal: 1, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/), estimatedInputTokens: expect.any(Number), maximumOutputTokens: 8192 });
    expect(j.reconcile).toHaveBeenCalledWith({ ordinal: 1, inputTokens: 20, outputTokens: 10 });
    expect(JSON.stringify(vi.mocked(j.reserve).mock.calls)).not.toContain("FICTIONAL-PUBLIC-CLAIM");
    expect(vi.mocked(j.reserve).mock.invocationCallOrder[0]).toBeLessThan(transport.mock.invocationCallOrder[0]);
  });
});
