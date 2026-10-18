import { afterEach, expect, it, vi } from "vitest";
import { executeComparison } from "./execute";
import { fictionalBatch, fictionalInputs, fictionalTransportReview } from "./fixtures.test-support";
import { LIMITS } from "./limits";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps review SDK requests independent of the source index while generation retains it unedited", async () => {
  for (const [key, value] of Object.entries({ AI_PROVIDER: "azure", AZURE_OPENAI_BASE_URL: "https://example.invalid/openai",
    AZURE_API_KEY: "fictional", AZURE_OPENAI_DEPLOYMENT_NAME: "fictional", AZURE_OPENAI_API_VERSION: "v1" })) vi.stubEnv(key, value);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const fixture = fictionalInputs(), tasks: string[] = [], reviewBodies: string[] = [], generationBodies: string[] = [], sourceBodies: string[] = [];
  let mode = "ordinary";
  let readings: { sourceDigest: string; reading: string }[] = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(String(url)).toMatch(/^https:\/\/example\.invalid\//);
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.input[1].content[0].text);
    expect(Buffer.byteLength(String(init?.body), "utf8") + 8192).toBeLessThanOrEqual(LIMITS.inputBytes);
    tasks.push(input.task);
    // This fails on the previous contract: comparison and reading shared a response.
    if (tasks.length === 1) expect(input.task).toBe("read_sources");
    let answer;
    if (input.task === "read_sources") {
      sourceBodies.push(String(init?.body));
      expect(Object.keys(input).sort()).toEqual(["sources", "task"]);
      expect(JSON.stringify(input)).not.toMatch(/sourceAnalysis|results|verdict|differences|unconfirmed/);
      readings = input.sources.map((s: { sourceDigest: string }) => ({ sourceDigest: s.sourceDigest,
        reading: mode === "maximum-escaped" ? "\ud800".repeat(90) : "架空の必須条件と選択肢を別に読む補助索引。" }));
      expect(body.text.format.schema.type).toBe("object");
      answer = { sourceAnalysis: readings };
    } else if (input.task === "compare") {
      expect(input.sourceAnalysis).toEqual(readings);
      generationBodies.push(String(init?.body));
      expect(input.base.claims[0].segments.map((s: {text:string}) => s.text).join("")).toBe(fixture.inputs.draft.source.claims[0].text);
      answer = fictionalBatch(input);
    } else {
      expect(input.task).toBe("review");
      expect(input).not.toHaveProperty("sourceAnalysis");
      expect(String(init?.body)).not.toContain(readings[0].reading);
      reviewBodies.push(String(init?.body));
      answer = fictionalTransportReview(input);
    }
    return Response.json({ id: "resp_fixture", created_at: 0, model: "fictional", status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }] }], usage: { input_tokens: 100, output_tokens: 100 } });
  }));
  expect((await executeComparison(fixture.inputs, fixture.selection)).review).toBe("human_review_required");
  expect(tasks).toEqual(["read_sources", "compare", "review"]);
  mode = "maximum-escaped";
  tasks.length = 0;
  expect((await executeComparison(fixture.inputs, fixture.selection)).review).toBe("human_review_required");
  expect(tasks).toEqual(["read_sources", "compare", "review"]);
  expect(generationBodies[0]).not.toBe(generationBodies[1]);
  expect(sourceBodies[0]).toBe(sourceBodies[1]);
  expect(reviewBodies[0]).toBe(reviewBodies[1]);
});
