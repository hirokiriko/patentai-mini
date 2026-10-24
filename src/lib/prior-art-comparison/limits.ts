// Preserve the existing source output allowance for the bounded high-effort trial.
// Reasoning and visible output remain within the same unchanged token ceiling.
export const LIMITS = Object.freeze({ calls: 3, pairsPerCall: 2, reviewPairs: 4, milliseconds: 230_000,
  sourceClaims: 19, claimOperationMilliseconds: 5_640_000, claimDiagnosticQaMilliseconds: 900_000,
  requestMilliseconds: 210_000, sourceRequestMilliseconds: 270_000, inputBytes: 120_000, outputTokens: 8192, azureSourceLowOutputTokens: 32400, azureSourceOutputTokens: 16384, azureReasoningOutputTokens: 22528 } as const);

/** Reasoning and the visible structured answer share this output allowance. */
export type ComparisonPhase = "source" | "generation" | "review";
export function comparisonOutputTokens(model: { provider: string; modelId: string }, phase: ComparisonPhase = "generation"): number {
  const knownAzure=model.provider === "azure.responses" && (model.modelId === "patentai-gpt54" || /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId));
  return knownAzure&&phase==="source"?LIMITS.azureSourceLowOutputTokens:
    knownAzure&&phase==="review"?LIMITS.azureReasoningOutputTokens:LIMITS.outputTokens;
}

/** Only the identified Azure source phase has the bounded longer wait. */
export function comparisonRequestMilliseconds(model: { provider: string; modelId: string }, phase: ComparisonPhase = "generation"): number {
  const knownAzure=model.provider === "azure.responses" && (model.modelId === "patentai-gpt54" || /^gpt-5\.4(?:-\d{4}-\d{2}-\d{2})?$/.test(model.modelId));
  return knownAzure&&phase==="source"?LIMITS.sourceRequestMilliseconds:LIMITS.requestMilliseconds;
}
