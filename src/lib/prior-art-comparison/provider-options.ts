import { getGoogleThinkingProviderOptions } from "../ai-model";
import type { generateObject } from "ai";
import type { ComparisonPhase } from "./limits";
type ProviderOptions = NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>;

/** Scoped to this comparison, without changing shared providers or deployment
 * configuration. The normal Azure alias is documented in
 * ops/azure-container-apps-deploy.md and verified as GPT-5.4 through ARM before
 * real acceptance. Unknown aliases remain unidentified. The SDK needs an explicit
 * reasoning-model override for this verified alias; request guards still verify
 * the actual model and the serialized reasoning option before sending. Pin
 * standard processing instead of inheriting a deployment's paid priority tier. */
export function comparisonProviderOptions(model: { provider: string; modelId: string }, phase: ComparisonPhase = "generation"): ProviderOptions | undefined {
  const reasoningEffort = ({ source: "low", generation: "low", review: "low" } as const)[phase];
  if (model.provider === "azure.responses" && model.modelId === "patentai-gpt54") {
    return { azure: { reasoningEffort, forceReasoning: true, serviceTier: "default" } };
  }
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId)) {
    if (model.provider === "azure.responses") return { azure: { reasoningEffort, serviceTier: "default" } };
    if (model.provider === "openai.responses") return { openai: { reasoningEffort: "low" as const } };
  }
  return getGoogleThinkingProviderOptions();
}
