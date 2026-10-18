import { generateObject } from "ai";
import { getModel } from "../ai-model";
import { aiOperationDeadline, withPriorArtComparisonBudget } from "../ai-operation-budget";
import { LIMITS, makePlan, savedDigest, SYSTEM, validateAnswer, validateSaved,
  type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { ComparisonError } from "./source";
import { decodeGeneration } from "./generation";
import { batchInput, batchSchema, batchSchemaFor, generationBatches } from "./generation-batch";
import { assertReviewSize, reviewInput, REVIEW_SYSTEM, validateReview, type ReviewDraft } from "./semantic-review";
import { decodeReviewTransport, reviewTransportInput, reviewTransportSchemaFor } from "./review-transport";
import type { z } from "zod";
import { comparisonProviderOptions } from "./provider-options";
import { comparisonOutputTokens, type ComparisonPhase } from "./limits";
import { mergeSourceAnalyses, validateSourceAnalysis, type SourceAnalysis } from "./source-analysis";

/** One finite synchronous operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection): Promise<SavedComparison> {
  const plan = makePlan(inputs, selection); // Entire scope must fit before any send.
  return withPriorArtComparisonBudget(async absolute => {
    const pairs: SavedComparison["pairs"] = [];
    const drafts: ReviewDraft[] = [];
    const analyses: SourceAnalysis[] = [];
    try {
      const generate = async (system: string, prompt: string, schema: z.ZodType, phase: ComparisonPhase) => {
        if (absolute.aborted) throw new ComparisonError("ai_incomplete");
        const model = getModel();
        const options = comparisonProviderOptions(model, phase);
        const outputTokens = comparisonOutputTokens(model, phase);
        const signal = AbortSignal.any([absolute, aiOperationDeadline(LIMITS.requestMilliseconds)]);
        const answer = await generateObject({ model, schema,
          system, prompt, maxRetries: 0,
          maxOutputTokens: outputTokens, abortSignal: signal,
          ...(options ? { providerOptions: options } : {}),
        });
        // Azure also reconciles transport usage in the existing budget. Preserve
        // the same fail-closed rule for other existing providers at this adapter.
        if (signal.aborted || !Number.isSafeInteger(answer.usage.inputTokens) || answer.usage.inputTokens! < 0 ||
            !Number.isSafeInteger(answer.usage.outputTokens) || answer.usage.outputTokens! < 0 ||
            answer.usage.inputTokens! > 150_000 || answer.usage.outputTokens! > outputTokens) throw new ComparisonError("ai_incomplete");
        if (options?.azure?.serviceTier === "default" && answer.providerMetadata?.azure?.serviceTier !== "default")
          throw new ComparisonError("ai_incomplete");
        return answer.object;
      };
      for (const batch of generationBatches(plan, SYSTEM)) {
        const answer = batchSchema.parse(await generate(SYSTEM, JSON.stringify(batchInput(batch)), batchSchemaFor(batch), "generation"));
        analyses.push(validateSourceAnalysis(batch, answer.sourceAnalysis));
        if (answer.results.some(r => !batch.some(c => c.candidateId === r.docId))) throw new ComparisonError("ai_incomplete");
        for (const chunk of batch) {
          const results = answer.results.filter(r => r.docId === chunk.candidateId).map(r => ({
            baseClaimNo: r.baseClaimNo, candidateClaimNo: r.candidateClaimNo, baseObservation: r.baseObservation, candidateObservation: r.candidateObservation,
            common: r.common, differences: r.differences, unconfirmed: r.unconfirmed, baseEvidenceId: r.baseEvidenceId, candidateEvidenceId: r.candidateEvidenceId }));
          const verified = validateAnswer(chunk, decodeGeneration(chunk, { results }));
          pairs.push(...verified);
          for (const p of verified) {
            const r = results.find(r => r.baseClaimNo === p.baseClaimNo && r.candidateClaimNo === p.candidateClaimNo)!;
            drafts.push({ ...p, baseObservation: r.baseObservation, candidateObservation: r.candidateObservation });
          }
        }
      }
      const review = reviewInput(plan, drafts, mergeSourceAnalyses(analyses));
      assertReviewSize(review);
      const rawReview = await generate(REVIEW_SYSTEM, JSON.stringify(reviewTransportInput(review)), reviewTransportSchemaFor(review), "review");
      validateReview(review, decodeReviewTransport(review, rawReview));
      if (absolute.aborted) throw new ComparisonError("ai_incomplete");
      const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: new Date().toISOString(),
        inputs, selection, pairs, status: "complete" as const, review: "human_review_required" as const };
      return validateSaved({ ...saved, snapshotDigest: savedDigest(saved) });
    } catch { throw new ComparisonError("ai_incomplete"); }
  });
}
