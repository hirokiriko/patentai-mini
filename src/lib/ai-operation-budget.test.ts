import { describe, expect, it, vi } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { generateObject } from "ai";
import { z } from "zod";
import { AiOperationBudget, AiOperationStopped, isAiOperationStopped } from "./ai-operation-budget";
import { runWithAiRetries } from "./ai-resilience";

const url = "https://example.invalid/openai/v1/responses";
const request = (changes = {}) => ({ method: "POST", body: JSON.stringify({
  model: "fictional", input: [{ role: "system", content: "fictional system" },
    { role: "user", content: [{ type: "input_text", text: "fictional input" }] }],
  max_output_tokens: 8192, text: { format: { type: "json_schema", schema: { type: "object" } } }, ...changes }),
});
describe("actual provider send budgets", () => {
  it.each(["normal", "fast"] as const)("refuses the next %s send without transport and retains unknown spend", async role => {
    const budget = new AiOperationBudget({ normal: 12, fast: 8 });
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("fictional transport failure"));
    const guarded = budget.wrapFetch(role, transport), maximum = role === "normal" ? 12 : 8;
    for (let n = 0; n < maximum; n++) await expect(guarded(url, request())).rejects.toThrow("fictional transport failure");
    await expect(guarded(url, request())).rejects.toBeInstanceOf(AiOperationStopped);
    expect(transport).toHaveBeenCalledTimes(maximum); expect(budget.used[role]).toBe(maximum);
  });
  it.each([
    { max_output_tokens: 8193 }, { max_output_tokens: undefined },
    { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }] },
    { previous_response_id: "fictional" }, { tools: [{ type: "web_search" }] },
    { prompt: { id: "fictional" } }, { background: true }, { stream: true },
    { input: [{ role: "user", content: "fictional", type: "item_reference", id: "fictional" }] },
    { text: { format: { schema: { description: "文".repeat(50_000) } } } },
  ])("rejects unbounded requests before transport", async changes => {
    const transport = vi.fn<typeof fetch>();
    await expect(new AiOperationBudget({ normal: 12, fast: 8 }).wrapFetch("normal", transport)(url, request(changes))).rejects.toBeInstanceOf(AiOperationStopped);
    expect(transport).not.toHaveBeenCalled();
  });
  it("shares SDK and outer retries and recognizes wrapped budget refusals", async () => {
    const budget = new AiOperationBudget({ normal: 0, fast: 2 });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 429 }));
    const azure = createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional", apiVersion: "v1", fetch: budget.wrapFetch("fast", transport) });
    const error = await runWithAiRetries("fictional", () => generateObject({ model: azure("fictional"),
      schema: z.object({ ok: z.boolean() }), prompt: "fictional", maxOutputTokens: 8192,
      maxRetries: 1, abortSignal: AbortSignal.timeout(10_000) }), { attempts: 2, delayMs: 0 }).catch(e => e);
    expect(isAiOperationStopped(error)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2); expect(budget.used.fast).toBe(2);
  });
  it("passes a real installed Azure SDK plain-text structured request", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed", content: [{ type: "output_text", text: '{"ok":true}', annotations: [] }] }],
      usage: { input_tokens: 20, output_tokens: 10 } }));
    const budget = new AiOperationBudget({ normal: 3, fast: 0 });
    const azure = createAzure({ baseURL: "https://example.invalid/openai", apiKey: "fictional", apiVersion: "v1", fetch: budget.wrapFetch("normal", transport) });
    const result = await generateObject({ model: azure("fictional"), schema: z.object({ ok: z.boolean() }), system: "fictional system",
      prompt: "fictional input", maxOutputTokens: 8192, maxRetries: 0, abortSignal: AbortSignal.timeout(1000) });
    expect(result.object).toEqual({ ok: true }); expect(budget.used.normal).toBe(1);
  });
  it("latches abort and never restores its reserved send", async () => {
    const controller = new AbortController(), budget = new AiOperationBudget({ normal: 3, fast: 0 });
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => { controller.abort(); throw new Error("fictional"); });
    const guarded = budget.wrapFetch("normal", transport);
    await expect(guarded(url, { ...request(), signal: controller.signal })).rejects.toBeInstanceOf(AiOperationStopped);
    await expect(guarded(url, request())).rejects.toBeInstanceOf(AiOperationStopped);
    expect(budget.used.normal).toBe(1); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("copies limits and exposes consumption as an immutable snapshot", async () => {
    const maximum = { normal: 1, fast: 0 }, budget = new AiOperationBudget(maximum);
    maximum.normal = 12;
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const guarded = budget.wrapFetch("normal", transport);
    const before = budget.used;
    await guarded(url, request());
    expect(before.normal).toBe(0); expect(Object.isFrozen(before)).toBe(true);
    await expect(guarded(url, request())).rejects.toBeInstanceOf(AiOperationStopped);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("normalizes wrapped refusal without retaining prior request/error data", async () => {
    const wrapped = Object.assign(new Error("fictional-private-marker"), { errors: [new Error("fictional-private-body"), new AiOperationStopped()] });
    const error = await runWithAiRetries("fictional", async () => { throw wrapped; }).catch(e => e);
    expect(error).toBeInstanceOf(AiOperationStopped);
    expect(error.message).toBe("ai_operation_stopped");
    expect(error.cause).toBeUndefined(); expect(error.errors).toBeUndefined();
  });
});
