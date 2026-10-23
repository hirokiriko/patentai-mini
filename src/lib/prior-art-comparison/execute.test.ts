import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalClauseInputs as fictionalInputs } from "./source-clause-fixtures.test-support";
import { fictionalPropositionGeneration as fictionalBatch, fictionalPropositionTarget as fictionalReview, fixturePropositionWire as wireGuards } from "./proposition-fixtures.test-support";
import { makePlan, validateSaved } from "./comparison";
import { batchInput, generationBatches } from "./generation-batch";
import { SYSTEM } from "./comparison";
import type { propositionTargetTransport } from "./proposition-extraction";
import {fictionalClaimSource as fictionalSourceAnalysis,type FictionalClaimRequest} from "./source-claim-fixtures.test-support";
import {sourceClaimExtractionPlan} from "./source-claim-extraction";
import { parseComparisonSource } from "./source";
import { fictionalInputs as longFictionalInputs } from "./fixtures.test-support";

const sourceCallCount=(inputs:Parameters<typeof makePlan>[0],selection:Parameters<typeof makePlan>[1])=>sourceClaimExtractionPlan(makePlan(inputs,selection)).tasks.length;

function stageAnswer(input: ReturnType<typeof batchInput> | ReturnType<typeof propositionTargetTransport> | FictionalClaimRequest) {
  return input.task === "extract_source_propositions" ? fictionalSourceAnalysis(input) : input.task === "review" ? fictionalReview(input) : fictionalBatch(input);
}

const SECRET = "FICTIONAL_PRIVATE_ERROR_SENTINEL";
function response(value: unknown, usage: unknown = { input_tokens: 100, output_tokens: 30 }, tier: Record<string, unknown> = { service_tier: "default" }) {
  return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed", ...tier,
    output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(wireGuards(value)), annotations: [] }] }], usage });
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
      const chunk: Parameters<typeof stageAnswer>[0] = JSON.parse(body.input[1].content[0].text);
      expect(body.max_output_tokens).toBe(8192);
      expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThan(150_000);
      if (chunk.task === "extract_source_propositions") return response(fictionalSourceAnalysis(chunk));
      if (chunk.task === "review") {
        const expanded=chunk.originals;
        const full=(claim:typeof expanded.base.claims[number])=>claim.segments.map(([,index])=>chunk.textParts[index]).join("");
        expect(full(expanded.base.claims[0])).toBe(inputs.draft.source.claims[0].text);
        expect(expanded.targets).toHaveLength(10);
        expect(expanded.documents.map(d=>full(d.source.claims[0]))).toEqual(inputs.documents.map(d=>d.source.claims[0].text));
        return response(fictionalReview(chunk));
      }
      expect(chunk.base.claims[0].segments.map(s => s.text).join("")).toBe(inputs.draft.source.claims[0].text);
      for (const d of chunk.documents) expect(d.candidate.claims[0].segments.map(s => s.text).join("")).toBe(inputs.documents.find(c => c.id === d.candidateId)!.source.claims[0].text);
      return response(fictionalBatch(chunk));
    }));
    const saved = await executeComparison(inputs, selection);
    expect(payloads).toHaveLength(sourceCallCount(inputs,selection)+2);
    expect(payloads.at(-1)).toContain("下回ると青色弁を開く");
    expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    const usage=vi.mocked(console.info).mock.calls.filter(row=>row[0]==="prior_art_comparison_usage").map(row=>JSON.parse(row[1]));
    expect(usage).toEqual([...sourceClaimExtractionPlan(makePlan(inputs,selection)).tasks.map(t=>({operationId:saved.operationId,phase:"source",sourceTaskId:t.id,inputTokens:100,outputTokens:30,status:"reconciled"})),...["generation","review"].map(phase=>({operationId:saved.operationId,phase,inputTokens:100,outputTokens:30,status:"reconciled"}))]);
  });
  it.each(["unknown_usage", "excess_usage", "http", "quote", "missing_pair", "protocol_metadata", "secret_error"])("fails closed without another send on %s", async mode => {
    const { inputs, selection } = fictionalInputs(); const answer = fictionalBatch(batchInput(generationBatches(makePlan(inputs, selection), SYSTEM)[0]));
    if (mode === "quote") answer.results[0].baseEvidenceId = "unknown";
    if (mode === "missing_pair") answer.results = [];
    if (mode === "protocol_metadata") answer.results[0].unconfirmed = "quotable=falseのため比較できません。";
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      if (mode === "secret_error") throw Error(SECRET);
      if (mode === "http") return new Response(SECRET, { status: 429 });
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task === "extract_source_propositions") return response(fictionalSourceAnalysis(input), mode === "unknown_usage" ? null : mode === "excess_usage" ? { input_tokens: 999999, output_tokens: 30 } : undefined);
      return response(answer, mode === "unknown_usage" ? null : mode === "excess_usage" ? { input_tokens: 999999, output_tokens: 30 } : undefined);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(["quote", "missing_pair", "protocol_metadata"].includes(mode) ? sourceCallCount(inputs,selection)+1 : 1);
    if(["unknown_usage","excess_usage","http","secret_error"].includes(mode))
      expect(vi.mocked(console.info).mock.calls.filter(row=>row[0]==="prior_art_comparison_usage")).toHaveLength(0);
  });
  it("keeps a successful comparison unchanged when optional usage logging fails",async()=>{
    const {inputs,selection}=compactFour();
    vi.mocked(console.info).mockImplementation(()=>{throw Error("fictional_logger_failure");});
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch",transport);
    const saved=await executeComparison(inputs,selection);
    expect(saved.status).toBe("complete");expect(saved.operationId).toBe(selection.operationId);
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
  it("does not send oversized plans", async () => {
    const { inputs, selection } = longFictionalInputs();
    selection.draftClaimNos = [1,2]; selection.documents.forEach(d => { d.claimNos = [1,2]; });
    const transport = vi.fn(); vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("plan_limit");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["missing", "reordered", "duplicate", "foreign", "blank", "overlong", "missing_reading", "unrelated_evidence"])("stops malformed source reading before generation: %s", async mode => {
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      expect(input.task).toBe("extract_source_propositions");
      const wire = fictionalSourceAnalysis(input), claim=wire.answer[`c${input.target.claimNo}`];
      if(mode==="missing")delete wire.answer[`c${input.target.claimNo}`];
      if(mode==="reordered")wire.claimNo=input.target.claimNo+1;
      if(mode==="duplicate")wire.answer.c999=structuredClone(claim);
      if(mode==="foreign")wire.sourceDigest="f".repeat(64);
      const firstFact=claim.facts[0];
      if(mode==="missing_reading")delete firstFact.m.a;
      if(mode==="unrelated_evidence")firstFact.W=[[0,0,0,0]];
      if(mode==="blank"||mode==="overlong"){
       const id=firstFact.m.J[0][0],index=claim.Q.findIndex((q:unknown)=>typeof q==="string"?q.startsWith(id+"|"):!!q&&typeof q==="object"&&(q as {id?:unknown}).id===id);
       expect(index).toBeGreaterThanOrEqual(0);claim.Q[index]=mode==="blank"?"":"甲".repeat(12001);
      }
      return response(wire);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toMatchObject({ message: "ai_incomplete", stage: "source_reading", kind: "protocol_invalid" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["quality", "missing_claim"])("stops a later source claim on %s with no remaining source/generation/review request",async mode=>{
    const {inputs,selection}=compactFour(),phases:string[]=[];
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);phases.push(input.task);
      expect(input.task).toBe("extract_source_propositions");
      const answer=fictionalSourceAnalysis(input);
      if(phases.length===3){
        if(mode==="missing_claim")delete answer.answer[`c${input.target.claimNo}`];
        else {const claim=answer.answer[`c${input.target.claimNo}`];claim.facts=[];}
      }
      return response(answer);
    });
    vi.stubGlobal("fetch",transport);
    await expect(executeComparison(inputs,selection)).rejects.toMatchObject({stage:"source_reading",kind:"protocol_invalid"});
    expect(transport).toHaveBeenCalledTimes(3);expect(phases).toEqual(Array(3).fill("extract_source_propositions"));
  });
  it.each(["http", "length", "coverage", "rejected"])("classifies a %s review without exposing raw errors or claiming semantic truth", async mode => {
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task !== "review") return response(stageAnswer(input));
      if (mode === "http") return new Response(SECRET, { status: 429 });
      const value = fictionalReview(input);
      if (mode === "coverage") value.targets.pop();
      if (mode === "rejected") Object.assign(value.targets[0].parts[0],{form:"unresolved",atoms:[]});
      const outer = await response(value).json();
      if (mode === "length") { outer.status = "incomplete"; outer.incomplete_details = { reason: "max_output_tokens" }; outer.output[0].content[0].text = '{"checks":'; }
      return Response.json(outer);
    });
    vi.stubGlobal("fetch", transport);
    const error = await executeComparison(inputs, selection).catch(error => error);
    expect(error).toMatchObject({ message: "ai_incomplete", stage: "review",
      kind: mode === "http" ? "transport_unknown" : mode === "length" ? "output_incomplete" : mode === "rejected" ? "review_rejected" : "protocol_invalid" });
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
  it("keeps cross-document generated results attached to their own source", async()=>{
    const {inputs,selection}=fictionalInputs();
    inputs.draft=parseComparisonSource("【請求項1】\n基準は熱を記録する装置。",11,"基準");
    inputs.documents=[21,22,23].map(id=>parseComparisonSource(`【請求項1】\n架空${id}は熱を記録する装置。`,id,`架空${id}`));
    selection.documents=inputs.documents.map(d=>({docId:d.id,claimNos:[1],identity:{publication:d.label,edition:"架空"}}));
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch",transport);
    const saved=await executeComparison(inputs,selection);
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
    expect(saved.pairs.map(p=>p.candidateEvidence.quote)).toEqual(inputs.documents.map(d=>d.source.claims[0].text));
  });
  it("sends all four complete pairs through source reading, one generation and one review", async () => {
    const { inputs, selection } = compactFour(), phases: string[] = [];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text); phases.push(input.task);
      if (input.task === "review") { expect(input.originals.targets).toHaveLength(20); return response(fictionalReview(input)); }
      if (input.task === "extract_source_propositions") return response(fictionalSourceAnalysis(input));
      expect(body.max_output_tokens).toBe(8192);
      expect(body.text.format.schema.properties.results.maxItems).toBeUndefined();
      expect(body.text.format.schema.properties.results.description).toContain('"maxItems":4');
      expect(input.documents.map((d: {pairs: unknown[]}) => d.pairs.length)).toEqual([2, 2]);
      for (const d of input.documents) for (const c of d.candidate.claims)
        expect(c.segments.map((s: {text:string}) => s.text).join(""))
          .toBe(inputs.documents.find(source => source.id === d.candidateId)!.source.claims.find(source => source.claimNo === c.claimNo)!.text);
      return response(fictionalBatch(input), { input_tokens: 100, output_tokens: 8192 });
    });
    vi.stubGlobal("fetch", transport);
    const saved = await executeComparison(inputs, selection);
    expect(phases).toEqual([...Array(sourceCallCount(inputs,selection)).fill("extract_source_propositions"), "compare", "review"]); expect(saved.pairs).toHaveLength(4);
    expect(saved.pairs.map(p => [p.docId, p.candidateClaimNo])).toEqual([[21, 2], [21, 3], [22, 2], [22, 3]]);
    expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
  });
  it.each(["missing", "duplicate", "foreign-document", "cross-document-evidence", "truncated"])("stops a malformed four-pair generation: %s", async mode => {
    const { inputs, selection } = compactFour();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task === "extract_source_propositions") return response(fictionalSourceAnalysis(input));
      const answer = fictionalBatch(input);
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
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete"); expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+1);
  });
  it.each(["valid", "wrong-scope", "duplicate", "foreign-pair"])("preserves three-plus-one pairs through the existing decoder: %s", async mode => {
    const { inputs, selection } = compactFour();
    selection.documents[0].claimNos = [1, 2, 3]; selection.documents[1].claimNos = [1];
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task !== "compare") return response(stageAnswer(input));
      const answer = fictionalBatch(input);
      if (mode === "wrong-scope") answer.results[0].candidateEvidenceId = answer.results[2].candidateEvidenceId;
      if (mode === "duplicate") answer.results[1] = { ...answer.results[0] };
      if (mode === "foreign-pair") answer.results[0].candidateClaimNo = 99;
      return response(answer);
    });
    vi.stubGlobal("fetch", transport);
    if (mode === "valid") {
      const saved = await executeComparison(inputs, selection);
      expect(saved.pairs.map(p => [p.docId, p.candidateClaimNo])).toEqual([[21, 1], [21, 2], [21, 3], [22, 1]]);
      expect(validateSaved(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
      expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
    } else {
      await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
      expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+1);
    }
  });
  it("completes a packed generation and 205-second review within one absolute deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const c = new AbortController(); setTimeout(() => c.abort(), ms); return c.signal; });
    const { inputs, selection } = compactFour();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      await new Promise(r => setTimeout(r, input.task === "review" ? 205_000 : 10_000));
      return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch", transport); const pending = executeComparison(inputs, selection);
    await vi.advanceTimersByTimeAsync((sourceCallCount(inputs,selection)+1)*10_000+205_001); expect((await pending).status).toBe("complete"); expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
  it.each(["inconsistent", "uncertain", "missing", "duplicate", "wrong_digest", "missing_support", "wrong_side", "legacy_wire", "evidence_id", "anchor", "valid_negative", "http", "unknown_usage"])("never completes or retries a %s review", async mode => {
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if (input.task === "compare") return response(fictionalBatch(input));
      if (input.task === "extract_source_propositions") return response(fictionalSourceAnalysis(input));
      const value = fictionalReview(input);
      const first=value.targets[0].parts[0],atom=first.atoms[0];
      if (mode === "http") return new Response(SECRET, { status: 429 });
      if (mode === "inconsistent" || mode === "valid_negative") {
        if(atom.meaning.kind!=="relation")throw Error("fixture_relation");
        atom.meaning.predicate="opens";
      }
      if (mode === "uncertain") Object.assign(first,{form:"unresolved",atoms:[]});
      if (mode === "missing") value.targets.pop();
      if (mode === "duplicate") value.targets[1] = value.targets[0];
      if (mode === "wrong_digest") value.draftDigest = "0".repeat(64);
      if (mode === "missing_support") atom.sourceIds=[];
      if (mode === "wrong_side") atom.scope="candidate:21:1";
      if (mode === "legacy_wire") Object.assign(value, { checks: [] });
      if (mode === "evidence_id") atom.sourceIds=["absent"];
      if (mode === "anchor") atom.basis=[[0,999]];
      return response(value, mode === "unknown_usage" ? null : undefined);
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);

  });
  it.each(["gpt-5.4","gpt-5.4-2026-03-05","patentai-gpt54"])("sends phase-specific reasoning and output through the actual guarded SDK on %s",async model=>{
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME",model);
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const body=JSON.parse(String(init?.body));
      expect(body.model).toBe(model);
      const phase = JSON.parse(body.input[1].content[0].text).task;
      expect(body.reasoning).toEqual({effort:"low"});
      expect(body.max_output_tokens).toBe(phase === "extract_source_propositions" ? 32400 : phase === "review" ? 22528 : 8192);
      expect(body.service_tier).toBe("default");
      expect(Object.keys(body).sort()).toEqual(["input","max_output_tokens","model","reasoning","service_tier","text"]);
      const input=JSON.parse(body.input[1].content[0].text);
      return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch",transport);
    expect((await executeComparison(inputs,selection)).status).toBe("complete");
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
  it.each(["generation", "review"])("rejects missing or nonstandard %s tier without a later send", async phase => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME", "patentai-gpt54");
    const { inputs, selection } = fictionalInputs();
    for (const tier of ["priority", "auto", null, undefined]) {
      const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
        expect(body.service_tier).toBe("default");
        return response(stageAnswer(input), undefined,
          (input.task === "review" ? phase === "review" : phase === "generation") ? { service_tier: tier } : { service_tier: "default" });
      });
      vi.stubGlobal("fetch", transport);
      await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
      expect(transport).toHaveBeenCalledTimes(phase === "generation" ? 1 : sourceCallCount(inputs,selection)+2);
    }
  });
  it("preserves unidentified deployment tier behavior", async () => {
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
      expect(body.service_tier).toBeUndefined();
      return response(stageAnswer(input), undefined, { service_tier: "priority" });
    });
    vi.stubGlobal("fetch", transport);
    expect((await executeComparison(inputs, selection)).status).toBe("complete");
  });
  it.each(["source", "generation", "review"] as const)("stops on %s usage above its own cap without another send", async phase => {
    vi.stubEnv("AZURE_OPENAI_DEPLOYMENT_NAME", "patentai-gpt54");
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const input = JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      const current=input.task==="extract_source_propositions"?"source":input.task==="review"?"review":"generation";
      return response(stageAnswer(input),
        { input_tokens: 100, output_tokens: current===phase ? ({source:32401,generation:8193,review:22529})[phase] : 30 });
    });
    vi.stubGlobal("fetch", transport);
    await expect(executeComparison(inputs, selection)).rejects.toThrow("ai_incomplete");
    expect(transport).toHaveBeenCalledTimes(({source:1,generation:sourceCallCount(inputs,selection)+1,review:sourceCallCount(inputs,selection)+2})[phase]);
  });
  it("can complete all SDK calls beyond 35 seconds without omitting review",async()=>{
    vi.useFakeTimers();
    vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      await new Promise(r=>setTimeout(r,40000));return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch",transport);
    const result=executeComparison(inputs,selection);
    await vi.advanceTimersByTimeAsync((sourceCallCount(inputs,selection)+2)*40000+1);
    expect((await result).status).toBe("complete");expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
  it("stops at the comparison-only per-send deadline and never starts a second call", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => { const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal; });
    const { inputs, selection } = fictionalInputs();
    const transport = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    vi.stubGlobal("fetch", transport);
    const promise = executeComparison(inputs, selection);
    const rejected = expect(promise).rejects.toMatchObject({ message: "ai_incomplete", stage: "source_reading", kind: "timeout" });
    await vi.advanceTimersByTimeAsync(210001);
    await rejected;
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retains a finite claim-operation budget and stops a stalled final review",async()=>{
    vi.useFakeTimers();
    vi.spyOn(AbortSignal,"timeout").mockImplementation(ms=>{const c=new AbortController();setTimeout(()=>c.abort(),ms);return c.signal;});
    const {inputs,selection}=fictionalInputs();
    const transport=vi.fn<typeof fetch>().mockImplementation(async(_url,init)=>{
      const input=JSON.parse(JSON.parse(String(init?.body)).input[1].content[0].text);
      if(input.task==="review") return new Promise(()=>undefined);
      await new Promise(r=>setTimeout(r,80000));return response(stageAnswer(input));
    });
    vi.stubGlobal("fetch",transport);
    const rejected=expect(executeComparison(inputs,selection)).rejects.toMatchObject({ message: "ai_incomplete", stage: "review", kind: "timeout" });
    await vi.advanceTimersByTimeAsync((sourceCallCount(inputs,selection)+1)*80000+210001);await rejected;
    expect(transport).toHaveBeenCalledTimes(sourceCallCount(inputs,selection)+2);
  });
});
