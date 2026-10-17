import { getGoogleThinkingProviderOptions } from "../ai-model";
import type { generateObject } from "ai";
type ProviderOptions = NonNullable<Parameters<typeof generateObject>[0]["providerOptions"]>;

/** Scoped to this comparison, without changing shared providers or deployment
 * configuration. An Azure deployment alias is not evidence of its model type;
 * never force reasoning for an unidentified model. Real acceptance must verify
 * the deployment through ARM and the actual request's reasoning option. */
export function comparisonProviderOptions(model: { provider: string; modelId: string }): ProviderOptions | undefined {
  if (/^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId)) {
    if (model.provider === "azure.responses") return { azure: { reasoningEffort: "low" as const } };
    if (model.provider === "openai.responses") return { openai: { reasoningEffort: "low" as const } };
  }
  return getGoogleThinkingProviderOptions();
}
