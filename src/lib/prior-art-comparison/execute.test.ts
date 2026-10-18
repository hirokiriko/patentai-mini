import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalBatch, fictionalInputs, fictionalTransportReview as fictionalReview } from "./fixtures.test-support";
import { makePlan, validateSaved } from "./comparison";
import { batchInput, generationBatches } from "./generation-batch";
import { SYSTEM } from "./comparison";
import { inspectReviewCoverage } from "./semantic-review";
import * as semanticReview from "./semantic-review";
import type { reviewTransportInput } from "./review-transport";
import { expandReviewTransportInput } from "./review-transport";
import { parseComparisonSource } from "./source";

const SECRET = "FICTIONAL_PRIVATE_ERROR_SENTINEL";
function response(value: unknown, usage: unknown = { input_tokens: 100, output_tokens: 30 }, tier: Record<string, unknown> = { service_tier: "default" }) {
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed", ...tier,
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }], usage });
}
function compactFour() {
  const f = fictionalInputs();
  f.inputs.draft = parseComparisonSource("【請求項1】\n温度を記録する基準装置。", 11, "基準");
  const body = "【請求項1】\n温度を記録する装置。\n【請求項2】\n請求項1に記載の装置であって、末尾で赤色信号を保持する。\n【請求項3】\n請求項1に記載の装置であって、末尾で青色信号を送信する。";
  f.inputs.documents = [21, 22].map(id => parseComparisonSource(body, id, `架空${id}`));
  f.selection.documents = f.inputs.documents.map(d => ({ docId: d.id, claimNos: [2, 3], identity: { publication: d.label, edition: "架空" } }));
  return f;
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
      const chunk: ReturnType<typeof batchInput> | ReturnType<typeof reviewTransportInput> = JSON.parse(body.input[1].content[0].text);
      expect(body.max_output_tokens).toBe(8192);
      expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThan(150_000);
      if (chunk.task === "review") {
        const expanded = expandReviewTransportInput(chunk);
        expect(expanded.base.claims[0][2].map(([, text]) => text).join("")).toBe(inputs.draft.source.claims[0].text);
        expect(chunk.fields).toHaveLength(10);
        expect(expanded.documents.map(d => d.source.claims[0][2].map(([, text]) => text).join(""))).toEqual(inputs.documents.map(d => d.source.claims[0].text));
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
  it.each(["unknown_usage", "excess_usage", "http", "quote", "missing_pair", "missing_analysis", "foreign_analysis", "blank_analysis", "protocol_metadata", "secret_error"])("fails closed without another send on %s", async mode => {
    const { inputs, selection } = fictionalInputs(); const answer = fictionalBatch(batchInput(generationBatches(makePlan(inputs, selection), SYSTEM)[0]));
    if (mode === "quote") answer.results[0].baseEvidenceId = "unknown";
    if (mode === "missing_pair") answer.results = [];
    if (mode === "missing_analysis") answer.sourceAnalysis.pop();
    if (mode === "foreign_analysis") answer.sourceAnalysis[0].sourceDigest = "f".repeat(64);
    if (mode === "blank_analysis") answer.sourceAnalysis[0].reading = "　 ";
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
    expect(transport).toHaveBeenCalledTimes(2);
    expect(saved.pairs.map(p=>p.candidateEvidence.quote)).toEqual(inputs.documents.map(d=>d.source.claims[0].text));
  });
  it("sends all four complete pairs through one guarded generation and one review", async () => {
    const { inputs, selection } = compactFour(), phases: string[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text); phases.push(input.task);
      if (input.task === "review") { expect(input.fields).toHaveLength(20); return response(fictionalReview(input)); }
      expect(body.max_output_tokens).toBe(8192); expect(body.text.format.schema.properties.results.maxItems).toBe(4);
      expect(input.documents.map((d: {pairs: unknown[]}) => d.pairs.length)).toEqual([2, 2]);
      for (const d of input.documents) for (const c of d.candidate.claims)
        expect(c.segments.map((s: {text:string}) => s.text).join(""))
          .toBe(inputs.documents.find(source => source.id === d.candidateId)!.source.claims.find(source => source.claimNo === c.claimNo)!.text);
      return response(fictionalBatch(input), { input_tokens: 100, output_tokens: 8192 });
    });
    vi.stubGlobal("fetch", transport);
    const saved = await executeComparison(inputs, selection);
    expect(phases).toEqual(["compare", "review"]); expect(saved.pairs).toHaveLength(4);
    expect(saved.pairs.map(p => [p.docId, p.candidateClaimNo])).toEqual([[21, 2], [21, 3], [22, 2], [22, 3]]);
    expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it.each(["missing", "duplicate", "foreign-document", "cross-document-evidence", "truncated"])("stops a malformed four-pair generation: %s", async mode => {
    const { inputs, selection } = compactFour();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text), answer = fictionalBatch(input);
      if (mode === "missing") answer.results.pop();
      if (mode === "duplicate") answer.results[3] = { ...answer.results[0] };
      if (mode === "foreign-document") answer.results[0].docId = 999;
      if (mode === "cross-document-evidence") answer.results[0].candidateEvidenceId = answer.results[2].candidateEvidenceId;
      if (mode === "truncated") {
        const outer = await response(answer).json(); outer.output[0].content[0].text = JSON.stringify(answer).slice(0, -1);
        return Response.json(outer);
      }
      return response(answer);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete"); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("completes a packed generation and 205-second review within one absolute deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
    const { inputs, selection } = compactFour();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      await new Promise(r => setTimeout(r, input.task === "review" ? 205_000 : 10_000));
      return response(input.task === "review" ? fictionalReview(input) : fictionalBatch(input));
    });
    vi.stubGlobal("fetch", transport); const pending = executeComparison(inputs, selection);
    await vi.advanceTimersByTimeAsync(215_001); expect((await pending).status).toBe("complete"); expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each(["inconsistent", "uncertain", "missing", "duplicate", "wrong_digest", "missing_support", "wrong_side", "legacy_wire", "evidence_id", "anchor", "valid_negative", "http", "unknown_usage"])("never completes or retries a %s review", async mode => {
    const { inputs, selection } = fictionalInputs();
    let validNegativeProtocolPassed = false;
    const reviewGate = vi.spyOn(semanticReview, "validateReview");
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task === "compare") return response(fictionalBatch(input));
      const value = fictionalReview(input);
      const expanded = expandReviewTransportInput(input);
      if (mode === "http") return new Response(SECRET, { status: 429 });
      if (mode === "inconsistent" || mode === "uncertain") Object.assign(value.checks[0], { verdict: mode });
      if (mode === "missing") value.checks.pop();
      if (mode === "duplicate") value.checks[1] = value.checks[0];
      if (mode === "wrong_digest") value.draftDigest = "0".repeat(64);
      if (mode === "missing_support") value.checks[2].evidenceIds = [];
      if (mode === "wrong_side") value.checks[0].evidenceIds = [expanded.documents[0].source.claims[0][2][0][0]];
      if (mode === "legacy_wire") Object.assign(value, { sourceFacts: [] });
      if (mode === "evidence_id") value.checks[0].evidenceIds = [999999];
      if (mode === "anchor") Object.assign(value.checks[0], { verdict: "inconsistent", rejectedTargetSpan: [0, 999] });
      if (mode === "valid_negative") {
        value.checks[0].verdict = "inconsistent";
        const id = value.checks[0].evidenceIds[0], segment = expanded.base.claims.flatMap(c => c[2])
          .find(([key]) => key === id)!;
        Object.assign(value.checks[0], { counterEvidence: { targetQuote: typeof expanded.units[0] === "string" ? expanded.units[0] : expanded.units[0].join(""),
          sourceWitness: [{ evidenceId: id, quote: segment[1] }] } });
      }
      return response(value, mode === "unknown_usage" ? null : undefined);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(generationBatches(makePlan(inputs, selection), SYSTEM).length + 1);
    if (mode === "valid_negative") {
      const [logical, decoded] = reviewGate.mock.calls.at(-1)!;
      validNegativeProtocolPassed = inspectReviewCoverage(logical, decoded).checks[0].verdict === "inconsistent";
      expect(validNegativeProtocolPassed).toBe(true);
    }
  });
  it.each(["gpt-5.4","gpt-5.4-2026-03-05","patentai-gpt54"])("sends phase-specific reasoning and output through the actual guarded SDK on %s",async model=>{
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME",model);
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      const phase = JSON.parse(body.input[1].content[0].text).task;
      expect(body.reasoning).toEqual({effort:phase === "review" ? "medium" : "low"});
      expect(body.max_output_tokens).toBe(phase === "review" ? 22528 : 8192);
      expect(body.service_tier).toBe("default");
      expect(Object.keys(body).sort()).toEqual(["input","max_output_tokens","model","reasoning","service_tier","text"]);
      const input=JSON.parse(body.input[1].content[0].text);
      return response(input.task==="review"?fictionalReview(input):fictionalBatch(input));
    });
    vi.stubGlobal("fetch",transport);
    expect((await executeComparison(inputs,selection)).status).toBe("complete");
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it.each(["generation", "review"])("rejects missing or nonstandard %s tier without a later send", async phase => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME", "patentai-gpt54");
    const { inputs, selection } = fictionalInputs();
    for (const tier of ["priority", "auto", null, undefined]) {
      const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
        expect(body.service_tier).toBe("default");
        return response(input.task === "review" ? fictionalReview(input) : fictionalBatch(input), undefined,
          (input.task === "review" ? phase === "review" : phase === "generation") ? { service_tier: tier } : { service_tier: "default" });
      });
      vi.stubGlobal("fetch", transport);
      await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
      expect(transport).toHaveBeenCalledTimes(phase === "generation" ? 1 : 3);
    }
  });
  it("preserves unidentified deployment tier behavior", async () => {
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
      expect(body.service_tier).toBeUndefined();
      return response(input.task === "review" ? fictionalReview(input) : fictionalBatch(input), undefined, { service_tier: "priority" });
    });
    vi.stubGlobal("fetch", transport);
    expect((await executeComparison(inputs, selection)).status).toBe("complete");
  });
  it.each(["generation", "review"])("stops on %s usage above its own cap without another send", async phase => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME", "patentai-gpt54");
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      return response(input.task === "review" ? fictionalReview(input) : fictionalBatch(input),
        { input_tokens: 100, output_tokens: (input.task === "review" ? phase === "review" : phase === "generation") ? (phase === "review" ? 22529 : 8193) : 30 });
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(phase === "generation" ? 1 : 3);
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
    await vi.advanceTimersByTimeAsync(210001);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("shares one absolute 230-second deadline with the final review",async()=>{
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
    await vi.advanceTimersByTimeAsync(230001);await rejected;
    expect(transport).toHaveBeenCalledTimes(3);
  });
});
