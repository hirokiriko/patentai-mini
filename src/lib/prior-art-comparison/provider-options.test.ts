import { afterEach, describe, expect, it, vi } from "vitest";
import { comparisonProviderOptions } from "./provider-options";

afterEach(()=>vi.unstubAllEnvs());
describe("comparison-only reasoning",()=>{
  it.each(["azure.responses","openai.responses"])("enables low only for identified GPT-5.4 responses on %s",provider=>{
    vi.stubEnv("AI_PROVIDER",provider.split(".")[0]);
    for(const modelId of ["gpt-5.4","gpt-5.4-2026-03-05"]) expect(comparisonProviderOptions({provider,modelId})).toEqual({[provider.split(".")[0]]:{reasoningEffort:"low"}});
    for(const modelId of ["custom-alias","gpt-4o","gpt-5.4-pro","gpt-5.4-mini"]) expect(comparisonProviderOptions({provider,modelId})).toBeUndefined();
    expect(comparisonProviderOptions({provider:"unknown",modelId:"gpt-5.4"})).toBeUndefined();
  });
  it("recognizes only the documented Azure normal alias, preserving mini and unknown aliases",()=>{
    vi.stubEnv("AI_PROVIDER","azure");
    expect(comparisonProviderOptions({provider:"azure.responses",modelId:"patentai-gpt54"})).toEqual({azure:{reasoningEffort:"low",forceReasoning:true}});
    for(const modelId of ["patentai-gpt54-mini","custom-alias","patentai-gpt54-other"]) expect(comparisonProviderOptions({provider:"azure.responses",modelId})).toBeUndefined();
    expect(comparisonProviderOptions({provider:"openai.responses",modelId:"patentai-gpt54"})).toBeUndefined();
  });
  it("preserves the existing Google options and does not force Azure reasoning",()=>{
    vi.stubEnv("AI_PROVIDER","google");
    expect(comparisonProviderOptions({provider:"google.generative-ai",modelId:"gemini-3.1-flash-lite"})).toEqual({google:{thinkingConfig:{thinkingLevel:"minimal"}}});
  });
});
