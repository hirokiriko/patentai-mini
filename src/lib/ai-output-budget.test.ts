import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractClaims, type ExtractedClaims } from "./extract-claims";
import { generateQueries, type SearchQuerySet } from "./generate-queries";
import { analyzeOverlap, screenPriorArt } from "./analyze-overlap";

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));

// Exercise the installed Azure provider and AI SDK without network or credentials.
vi.mock("./ai-model", async () => {
  const { createAzure } = await import("@ai-sdk/azure");
  const { boundedAzureFetch } = await import("./ai-operation-budget");
  const azure = (role: "normal" | "fast") => createAzure({
    baseURL: "https://example.invalid/openai",
    apiKey: "test-only",
    apiVersion: "v1",
    fetch: boundedAzureFetch(role),
  });
  return {
    getFastModel: () => azure("fast")("test-fast"),
    getModel: () => azure("normal")("test-normal"),
    aiProviderRetries: () => 0,
    getGoogleThinkingProviderOptions: () => undefined,
  };
});

const extracted: ExtractedClaims = {
  title: "Fictional AI extraction",
  abstract: "A fictional temperature controller.",
  solvedProblems: ["Temperature variation"],
  effects: ["Stable temperature"],
  claims: [{
    claimNo: 1, text: "A controller receives temperature measurements.",
    isIndependent: true, dependsOn: null,
    elements: [{ type: "component", text: "controller", importance: "core" }],
  }],
};
const queries: SearchQuerySet = {
  keywordGroups: { core: ["controller"], synonyms: [], effects: [] },
  broadQuery: "[controller/TX]", balancedQuery: "[controller/CL]",
  narrowQuery: "[temperature/CL*controller/CL]",
  keywordQueries: [{ theme: "Fictional", keywords: "temperature controller" }],
  searchExpansionHints: {
    spellingVariants: [{ baseTerm: "controller", variants: ["control"], reason: "Variant", suggestedUse: "Review" }],
    companyNameHints: [],
    additionalKeywordQueries: [{ theme: "Fictional", keywords: "temperature", note: "Review" }],
    leakageRisks: ["Human review required"],
  },
  excludedTerms: [], rationale: ["Fictional AI query result"],
};
const priorArt = { docId: 1, publicationNo: null, title: "Fictional prior art", abstract: "Temperature control", claimsText: "A temperature controller." };
const screening = { relevantDocIds: [1], reasoning: "Fictional AI screening" };
const comparison = {
  draftClaimNo: 1, priorDocId: 1, lexicalScore: 0.2, elementScore: 0.3,
  semanticScore: 0.4, structuralScore: 0.2, matchedElements: ["controller"],
  unmatchedElements: ["timing"], riskLabel: "Low" as const,
  explanation: "Fictional overlap candidate requiring human review",
};

function respond(object: unknown) {
  return Response.json({
    id: "resp_test", created_at: 0, model: "test", status: "completed",
    output: [{ type: "message", id: "msg_test", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(object), annotations: [] }] }],
    usage: { input_tokens: 20, output_tokens: 30 },
  });
}

function assertBudget(deployment: string, calls: number) {
  expect(transport.fetch).toHaveBeenCalledTimes(calls);
  for (const [url, init] of transport.fetch.mock.calls) {
    expect(String(url)).toBe("https://example.invalid/openai/v1/responses?api-version=v1");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe(deployment);
    expect(body.max_output_tokens).toBe(8192);
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.schema.type).toBe("object");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.signal?.aborted).toBe(false);
  }
}

describe("AI output budget reaches the Azure request", () => {
  beforeEach(() => { transport.fetch.mockReset(); vi.stubGlobal("fetch", transport.fetch); });
  afterEach(() => vi.unstubAllGlobals());

  it("bounds extraction and returns the AI result rather than fallback", async () => {
    transport.fetch.mockResolvedValueOnce(respond(extracted));
    expect(await extractClaims("Fictional patent text")).toEqual(extracted);
    assertBudget("test-fast", 1);
  });

  it("bounds query generation and returns the AI query result", async () => {
    transport.fetch.mockResolvedValueOnce(respond(queries));
    expect(await generateQueries(extracted)).toEqual(queries);
    assertBudget("test-fast", 1);
  });

  it("bounds prior-art screening", async () => {
    transport.fetch.mockResolvedValueOnce(respond(screening));
    expect(await screenPriorArt(extracted, [priorArt])).toEqual(screening);
    assertBudget("test-normal", 1);
  });

  it("bounds overlap analysis", async () => {
    transport.fetch.mockResolvedValueOnce(respond({ results: [comparison] }));
    expect(await analyzeOverlap(extracted, [priorArt])).toEqual([comparison]);
    assertBudget("test-normal", 1);
  });

  it("stops without SDK or outer retry after unknown billed usage", async () => {
    transport.fetch
      .mockResolvedValueOnce(Response.json({ error: { message: "Test rate limit", type: "rate_limit_error" } }, { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(respond(screening));
    await expect(screenPriorArt(extracted, [priorArt])).rejects.toThrow("ai_operation_stopped");
    assertBudget("test-normal", 1);
  });
});
