import { generateObject } from "ai";
import { getModel, getGoogleThinkingProviderOptions } from "../ai-model";
import { aiOperationDeadline, withAiOperationBudget } from "../ai-operation-budget";
import { answerSchema, comparisonPrompt, LIMITS, makePlan, savedDigest, SYSTEM, validateAnswer, validateSaved,
  type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { ComparisonError } from "./source";

/** One finite synchronous operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection): Promise<SavedComparison> {
  const plan = makePlan(inputs, selection); // Entire scope must fit before any send.
  return withAiOperationBudget({ normal: LIMITS.calls, fast: 0 }, async () => {
    const absolute = aiOperationDeadline(LIMITS.milliseconds);
    const pairs: SavedComparison["pairs"] = [];
    try {
      for (const chunk of plan) {
        if (absolute.aborted) throw new ComparisonError("ai_incomplete");
        const options = getGoogleThinkingProviderOptions();
        const signal = AbortSignal.any([absolute, aiOperationDeadline(35_000)]);
        const answer = await generateObject({ model: getModel(), schema: answerSchema,
          system: SYSTEM, prompt: comparisonPrompt(chunk), maxRetries: 0,
          maxOutputTokens: LIMITS.outputTokens, abortSignal: signal,
          ...(options ? { providerOptions: options } : {}),
        });
        // Azure also reconciles transport usage in the existing budget. Preserve
        // the same fail-closed rule for other existing providers at this adapter.
        if (signal.aborted || !Number.isSafeInteger(answer.usage.inputTokens) || answer.usage.inputTokens! < 0 ||
            !Number.isSafeInteger(answer.usage.outputTokens) || answer.usage.outputTokens! < 0 ||
            answer.usage.inputTokens! > 150_000 || answer.usage.outputTokens! > LIMITS.outputTokens) throw new ComparisonError("ai_incomplete");
        pairs.push(...validateAnswer(chunk, answer.object));
      }
      if (absolute.aborted) throw new ComparisonError("ai_incomplete");
      const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: new Date().toISOString(),
        inputs, selection, pairs, status: "complete" as const, review: "human_review_required" as const };
      return validateSaved({ ...saved, snapshotDigest: savedDigest(saved) });
    } catch { throw new ComparisonError("ai_incomplete"); }
  });
}
