import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalGeneration, fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateSaved } from "./comparison";
import { generationInput } from "./generation";

const SECRET = "FICTIONAL_PRIVATE_ERROR_SENTINEL";
function response(value: unknown, usage: unknown = { input_tokens: 100, output_tokens: 30 }) {
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }], usage });
}
describe("real installed SDK, guarded fictional transport", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai", AZURE_API_KEY: "fictional",
      AZURE_OPENAI_DEPLOYMENT_NAME: "fictional", AZURE_OPENAI_API_VERSION: "v1" })) vi.stubEnv(key, value);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
  });
  afterEach(() => { expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(SECRET); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
  it("sends every selected full source tail and persists exactly its evidence", async () => {
    const { inputs, selection } = fictionalInputs();
    const payloads: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      expect(String(url)).toMatch(/^https:\/\/example\.invalid\/openai\//);
      payloads.push(String(init?.body));
      const body = JSON.parse(String(init?.body));
      const chunk: ReturnType<typeof generationInput> = JSON.parse(body.input[1].content[0].text);
      expect(body.max_output_tokens).toBe(8192);
      expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThan(150_000);
      expect(chunk.base.claims[0].segments.map(s => s.text).join("")).toBe(inputs.draft.source.claims[0].text);
      expect(chunk.candidate.claims[0].segments.map(s => s.text).join("")).toBe(inputs.documents[payloads.length - 1].source.claims[0].text);
      return response(fictionalGeneration(chunk));
    }));
    const saved = await executeComparison(inputs, selection);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toContain("下回ると青色弁を開く");
    expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it.each(["unknown_usage", "excess_usage", "http", "quote", "missing_pair", "protocol_metadata", "secret_error"])("fails closed without another send on %s", async mode => {
    const { inputs, selection } = fictionalInputs(); const answer = fictionalGeneration(generationInput(makePlan(inputs, selection)[0]));
    if (mode === "quote") answer.results[0].baseEvidenceId = "unknown";
    if (mode === "missing_pair") answer.results = [];
    if (mode === "protocol_metadata") answer.results[0].unconfirmed = "quotable=falseのため比較できません。";
    const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (mode === "secret_error") throw Error(SECRET);
      if (mode === "http") return new Response(SECRET, { status: 429 });
      return response(answer, mode === "unknown_usage" ? null : mode === "excess_usage" ? { input_tokens: 999999, output_tokens: 30 } : undefined);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not send oversized plans", async () => {
    const { inputs, selection } = fictionalInputs();
    selection.draftClaimNos = [1,2]; selection.documents.forEach(d => { d.claimNos = [1,2]; });
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("plan_limit");
    expect(transport).not.toHaveBeenCalled();
  });
  it("stops at the existing per-send deadline and never starts a second call", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; });
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", transport);
    const promise = executeComparison(inputs, selection);
    const rejected = expect(promise).rejects.toThrow("ai_incomplete");
    await vi.advanceTimersByTimeAsync(35001);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
