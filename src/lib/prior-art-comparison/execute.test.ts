import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalBatch, fictionalInputs, fictionalReview } from "./fixtures.test-support";
import { makePlan, validateSaved } from "./comparison";
import { batchInput, generationBatches } from "./generation-batch";
import { SYSTEM } from "./comparison";
import { inspectReviewCoverage, type reviewInput } from "./semantic-review";
import { parseComparisonSource } from "./source";

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
      const chunk: ReturnType<typeof batchInput> | ReturnType<typeof reviewInput> = JSON.parse(body.input[1].content[0].text);
      expect(body.max_output_tokens).toBe(8192);
      expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThan(150_000);
      if (chunk.task === "review") {
        expect(chunk.base.claims[0].segments.map(([, text]) => text).join("")).toBe(inputs.draft.source.claims[0].text);
        expect(chunk.targets).toHaveLength(10);
        expect(chunk.documents.map(d => d.source.claims[0].segments.map(([, text]) => text).join(""))).toEqual(inputs.documents.map(d => d.source.claims[0].text));
        return response(fictionalReview(chunk));
      }
      expect(chunk.base.claims[0].segments.map(s => s.text).join("")).toBe(inputs.draft.source.claims[0].text);
      for (const d of chunk.documents) expect(d.candidate.claims[0].segments.map(s => s.text).join("")).toBe(inputs.documents.find(c => c.id === d.candidateId)!.source.claims[0].text);
      return response(fictionalBatch(chunk));
    }));
    const saved = await executeComparison(inputs, selection);
    expect(payloads).toHaveLength(generationBatches(makePlan(inputs, selection), SYSTEM).length + 1);
    expect(payloads.at(-1)).toContain("下回ると青色弁を開く");
    expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it.each(["unknown_usage", "excess_usage", "http", "quote", "missing_pair", "protocol_metadata", "secret_error"])("fails closed without another send on %s", async mode => {
    const { inputs, selection } = fictionalInputs(); const answer = fictionalBatch(batchInput(generationBatches(makePlan(inputs, selection), SYSTEM)[0]));
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
  it("keeps cross-document generated results attached to their own source", async()=>{
    const {inputs,selection}=fictionalInputs();
    inputs.draft=parseComparisonSource("【請求項1】\n基準は熱を記録する装置。",11,"基準");
    inputs.documents=[21,22,23].map(id=>parseComparisonSource(`【請求項1】\n架空${id}は熱を記録する装置。`,id,`架空${id}`));
    selection.documents=inputs.documents.map(d=>({docId:d.id,claimNos:[1],identity:{publication:d.label,edition:"架空"}}));
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      return response(input.task==="review"?fictionalReview(input):fictionalBatch(input));
    });
    vi.stubGlobal("fetch",transport);
    const saved=await executeComparison(inputs,selection);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(saved.pairs.map(p=>p.candidateEvidence.quote)).toEqual(inputs.documents.map(d=>d.source.claims[0].text));
  });
  it.each(["inconsistent", "uncertain", "missing", "duplicate", "wrong_digest", "source_unresolved", "source_missing", "draft_basis", "fact_id", "anchor", "valid_negative", "http", "unknown_usage"])("never completes or retries a %s review", async mode => {
    const { inputs, selection } = fictionalInputs();
    let validNegativeProtocolPassed = false;
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task === "compare") return response(fictionalBatch(input));
      const value = fictionalReview(input);
      if (mode === "http") return new Response(SECRET, { status: 429 });
      if (mode === "inconsistent" || mode === "uncertain") Object.assign(value.checks[0], { verdict: mode });
      if (mode === "missing") value.checks.pop();
      if (mode === "duplicate") value.checks[1] = value.checks[0];
      if (mode === "wrong_digest") value.draftDigest = "0".repeat(64);
      if (mode === "source_unresolved") Object.assign(value.sourceAnalyses[0],{status:"unresolved"});
      if (mode === "source_missing") value.sourceAnalyses.pop();
      if (mode === "draft_basis") value.checks[0].unitChecks[0].targetReading.basisQuote = "当該文に存在しない断定";
      if (mode === "fact_id") value.sourceFacts[0].evidenceIds = ["c999:1:0"];
      if (mode === "anchor" || mode === "valid_negative") {
        Object.assign(value.checks[0].unitChecks[0], { verdict: "inconsistent" });
        Object.assign(value.checks[0], { verdict: "inconsistent", rejectedTargetAnchor: { unitStart: 0,
          quote: mode === "anchor" ? "当該文に存在しない断定" : input.targets[0].text.slice(0, input.targets[0].unitStarts[1]) } });
      }
      if (mode === "valid_negative") validNegativeProtocolPassed = inspectReviewCoverage(input, value).checks[0].verdict === "inconsistent";
      return response(value, mode === "unknown_usage" ? null : undefined);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(generationBatches(makePlan(inputs, selection), SYSTEM).length + 1);
    if (mode === "valid_negative") expect(validNegativeProtocolPassed).toBe(true);
  });
  it.each(["gpt-5.4","gpt-5.4-2026-03-05","patentai-gpt54"])("sends low reasoning with room for its answer through the actual guarded SDK on %s",async model=>{
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME",model);
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      expect(body.reasoning).toEqual({effort:"low"});
      expect(body.max_output_tokens).toBe(32768);
      expect(Object.keys(body).sort()).toEqual(["input","max_output_tokens","model","reasoning","text"]);
      const input=JSON.parse(body.input[1].content[0].text);
      return response(input.task==="review"?fictionalReview(input):fictionalBatch(input));
    });
    vi.stubGlobal("fetch",transport);
    expect((await executeComparison(inputs,selection)).status).toBe("complete");
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("can complete all SDK calls beyond 35 seconds without omitting review",async()=>{
    vi.useFakeTimers();
    vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      await new Promise(r=>setTimeout(r,40000));return response(input.task==="review"?fictionalReview(input):fictionalBatch(input));
    });
    vi.stubGlobal("fetch",transport);
    const result=executeComparison(inputs,selection);
    await vi.advanceTimersByTimeAsync(120001);
    expect((await result).status).toBe("complete");expect(transport).toHaveBeenCalledTimes(3);
  });
  it("stops at the comparison-only per-send deadline and never starts a second call", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; });
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", transport);
    const promise = executeComparison(inputs, selection);
    const rejected = expect(promise).rejects.toThrow("ai_incomplete");
    await vi.advanceTimersByTimeAsync(180001);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("shares one absolute 210-second deadline with the final review",async()=>{
    vi.useFakeTimers();
    vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if(input.task==="review") return new Promise(()=>undefined);
      await new Promise(r=>setTimeout(r,80000));return response(fictionalBatch(input));
    });
    vi.stubGlobal("fetch",transport);
    const rejected=expect(executeComparison(inputs,selection)).rejects.toThrow("ai_incomplete");
    await vi.advanceTimersByTimeAsync(210001);await rejected;
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
