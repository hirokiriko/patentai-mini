import { afterEach, describe, expect, it, vi } from "vitest";
import { fictionalBatch, fictionalInputs, fictionalReview } from "./fixtures.test-support";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire } from "./proposition-fixtures.test-support";
import { executeComparison } from "./execute";
import { makePlan, validateAnswer } from "./comparison";
import { parseComparisonSource } from "./source";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { inspectReviewCoverage, reviewInput, validateReview } from "./semantic-review";
import { compileLiteralStructure } from "./literal-structure";

const text = "前記第１の運転モードは光モードであり、前記第２の運転モードは、音モードと、振動モードと、表示モードのうちの何れか、又は、それらの組み合わせ、若しくは、それらの全てである。";
const wrong = "基準側は光・音・振動・表示のいずれか/組合せ/全てを対象とする。";
function fixture() {
  const value = fictionalInputs();
  value.inputs.draft = parseComparisonSource(`【請求項1】\n${text}`, 11, "架空基準");
  value.inputs.documents = [21, 22].map(id => parseComparisonSource(`【請求項1】\n${text}`, id, `架空候補${id}`));
  return value;
}
function generation(input: Parameters<typeof fictionalBatch>[0]) {
  const answer = fictionalBatch(input);
  for (const row of answer.results) Object.assign(row, { baseObservation: "第1運転モードは光モードである。",
    candidateObservation: "第1運転モードは光モードである。", common: "両側に光モードの記載がある。",
    differences: "基準側の第2運転モードは音・振動・表示のいずれかである。", unconfirmed: "個別動作の対応は要確認。" });
  return answer;
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("literal structure on the product path, with fictional SDK transport", () => {
  it.each(["valid", "reading", "generation", "reason"])("carries the independent projection and stops %s at its first rejection", async failure => {
    for (const [k, v] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai",
      AZURE_API_KEY: "fictional", AZURE_OPENAI_DEPLOYMENT_NAME: "fictional", AZURE_OPENAI_API_VERSION: "v1" })) vi.stubEnv(k, v);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { inputs, selection } = fictionalInputs(), tasks: string[] = [];
    const append=(s:typeof inputs.draft)=>parseComparisonSource(`【請求項1】\n装置は温度を保持する。${text}`,s.id,s.label);
    inputs.draft=append(inputs.draft);inputs.documents=inputs.documents.map(append);
    const expected = compileLiteralStructure(inputs.draft.source);
    const transportErrors:unknown[]=[];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      try {
      expect(String(url)).toMatch(/^https:\/\/example\.invalid\//);
      const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
      tasks.push(input.task);
      let answer;
      if (input.task === "extract_source_propositions") {
        expect(input.sources[0].source.literalStructure).toEqual(expected);
        expect(input.sources[0].source.claims[0].parts.map((id:number)=>input.textParts[id]).join("")).toBe(inputs.draft.source.claims[0].text);
        answer = fictionalPropositionSource(input);
        if (failure === "reading") answer.sources[0].facts[0].bindings[0].spans=[[0,1]];
      } else if (input.task === "compare") {
        expect(input.base.literalStructure).toEqual(expected);
        answer = fictionalPropositionGeneration(input);
        if (failure === "generation") answer.results[0].differences = wrong;
      } else {
        expect(input.originals.base.literalStructure).toEqual(expected);
        expect(input).not.toHaveProperty("sourceAnalysis");
        answer = fictionalPropositionTarget(input);
        if (failure === "reason") Object.assign(answer.targets[0].parts[0].atoms[0],{verdict:"consistent",reason:wrong});
      }
      return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
        output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(fixturePropositionWire(answer)), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 100 } });
      }catch(error){transportErrors.push(error);throw error;}
    }));
    const execution=executeComparison(inputs, selection).catch(error=>{throw transportErrors[0]??error;});
    if (failure === "valid") expect((await execution).review).toBe("human_review_required");
    else await expect(execution).rejects.toThrow("ai_incomplete");
    expect(tasks).toEqual(failure === "reading" ? ["extract_source_propositions"] : failure === "generation" ? ["extract_source_propositions", "compare"] : ["extract_source_propositions", "compare", "review"]);
  });
  it("does not promote a fictional C verdict over an original-derived counterexample or rewrite the response", () => {
    const { inputs, selection } = fixture(), plan = makePlan(inputs, selection), batch = generation(batchInput(plan));
    const drafts = plan.flatMap(c => {
      const rows = batch.results.filter(r => r.docId === c.candidateId).map(({ docId, ...r }) => { void docId; return r; });
      return validateAnswer(c, decodeGeneration(c, { results: rows })).map((p, i) => ({ ...p, ...rows[i], docId: c.candidateId, differences: wrong }));
    });
    const input = reviewInput(plan, drafts), answer = fictionalReview(input), before = JSON.stringify(answer);
    expect(inspectReviewCoverage(input, answer).checks.every(c => c.verdict === "consistent")).toBe(true);
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
    expect(JSON.stringify(answer)).toBe(before);
  });
});
