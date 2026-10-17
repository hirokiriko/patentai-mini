import { getGoogleThinkingProviderOptions } from "../ai-model";
import type { generateObject } from "ai";
type ProviderOptions = NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>;

/** Scoped to this comparison, without changing shared providers or deployment
 * configuration. The normal Azure alias is documented in
 * ops/azure-container-apps-deploy.md and verified as GPT-5.4 through ARM before
 * real acceptance. Unknown aliases remain unidentified. The SDK needs an explicit
 * reasoning-model override for this verified alias; request guards still verify
 * the actual model and the serialized reasoning option before sending. */
export function comparisonProviderOptions(model: { provider: string; modelId: string }): ProviderOptions | undefined {
  if (model.provider === "azure.responses" && model.modelId === "patentai-gpt54") {
    return { azure: { reasoningEffort: "medium" as const, forceReasoning: true } };
  }
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId)) {
    if (model.provider === "azure.responses") return { azure: { reasoningEffort: "medium" as const } };
    if (model.provider === "openai.responses") return { openai: { reasoningEffort: "low" as const } };
  }
  return getGoogleThinkingProviderOptions();
}
