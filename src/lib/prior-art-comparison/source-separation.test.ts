import { afterEach, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalClauseInputs as fictionalInputs, fictionalClauseSource as fictionalPropositionSource } from "./source-clause-fixtures.test-support";
import { fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire } from "./proposition-fixtures.test-support";
import { LIMITS } from "./limits";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps generation and target extraction independent of the first extractor's meanings", async () => {
  for (const [key, value] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai",
    AZURE_API_KEY: "fictional", AZURE_OPENAI_DEPLOYMENT_NAME: "fictional", AZURE_OPENAI_API_VERSION: "v1" })) vi.stubEnv(key, value);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fixture = fictionalInputs(), tasks: string[] = [];
  const transportErrors:unknown[]=[];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    try {
    expect(new URL(String(url)).origin).toBe("https://example.invalid");
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
    expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThanOrEqual(LIMITS.inputBytes);
    tasks.push(input.task);
    let answer;
    if (input.task === "extract_source_propositions") {
      expect(JSON.stringify(input)).not.toMatch(/sourceAnalysis|verdict|differences|unconfirmed/);
      answer=fictionalPropositionSource(input);
    } else if (input.task === "compare") {
      expect(input).not.toHaveProperty("sourcePropositions");
      expect(input.sourceAnalysis).toEqual([]);
      expect(input.base.claims[0].segments.map((s: {text:string}) => s.text).join("")).toBe(fixture.inputs.draft.source.claims[0].text);
      answer=fictionalPropositionGeneration(input);
    } else {
      expect(input.task).toBe("review");
      expect(input.method).toBe("extract_target_propositions");
      expect(input).not.toHaveProperty("sourceAnalysis");
      expect(input).not.toHaveProperty("sourcePropositions");
      expect(input.facts.version).toBe(2);
      expect(input.facts.rows.length).toBeGreaterThan(0);
      for(const fact of input.facts.rows){expect(fact).toHaveLength(5);expect(input.facts.bases[fact[2]]).toBeDefined();
        expect(fact[3]).toBeGreaterThanOrEqual(0);expect(fact[3]).toBeLessThanOrEqual(2);
        if(fact[4]!==null)expect(typeof input.facts.subjects[fact[4]]).toBe("string");}
      expect(input.originals.base.claims[0].segments.map(([,i]:[number,number])=>input.textParts[i]).join("")).toBe(fixture.inputs.draft.source.claims[0].text);
      answer=fictionalPropositionTarget(input);
    }
    return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(fixturePropositionWire(answer)), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 100 } });
    }catch(error){transportErrors.push(error);throw error;}
  }));
  expect((await executeComparison(fixture.inputs, fixture.selection).catch(error=>{throw transportErrors[0]??error;})).review).toBe("human_review_required");
  expect(tasks).toEqual(["extract_source_propositions", "compare", "review"]);
});
