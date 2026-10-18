import { generateObject } from "ai";
import { getModel } from "../ai-model";
import { aiOperationDeadline, withPriorArtComparisonBudget } from "../ai-operation-budget";
import { LIMITS, makePlan, savedDigest, SYSTEM, validateAnswer, validateSaved,
  type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { ComparisonError } from "./source";
import { decodeGeneration } from "./generation";
import { batchTransportInput, batchSchema, batchSchemaFor, requestBytes } from "./generation-batch";
import { assertReviewSize, inspectReviewCoverage, reviewInput, REVIEW_SYSTEM, validateReview, type ReviewDraft } from "./semantic-review";
import { decodeReviewTransport, reviewTransportInput, reviewTransportSchemaFor } from "./review-transport";
import type { z } from "zod";
import { comparisonProviderOptions } from "./provider-options";
import { comparisonOutputTokens, type ComparisonPhase } from "./limits";
import { sourceAnalysisInput, sourceReadingSchemaFor, SOURCE_ANALYSIS_SYSTEM, validateSourceAnalysis } from "./source-analysis";
import { separatedGenerationPlan } from "./source-separation";
import { ComparisonExecutionError, comparisonExecutionFailure, type ComparisonStage } from "./failure";

/** One finite synchronous operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection): Promise<SavedComparison> {
  const plan = makePlan(inputs, selection); // Entire scope must fit before any send.
  const batch = separatedGenerationPlan(plan, SYSTEM);
  return withPriorArtComparisonBudget(async absolute => {
    const pairs: SavedComparison["pairs"] = [];
    const drafts: ReviewDraft[] = [];
    let stage: ComparisonStage = "source_reading";
    try {
      const generate = async (system: string, prompt: string, schema: z.ZodType, phase: ComparisonPhase) => {
        if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
        const model = getModel();
        const options = comparisonProviderOptions(model, phase);
        const outputTokens = comparisonOutputTokens(model, phase);
        const signal = AbortSignal.any([absolute, aiOperationDeadline(LIMITS.requestMilliseconds)]);
        const answer = await generateObject({ model, schema,
          system, prompt, maxRetries: 0,
          maxOutputTokens: outputTokens, abortSignal: signal,
          ...(options ? { providerOptions: options } : {}),
        }).catch(error => {
          if (signal.aborted) throw new ComparisonExecutionError(stage, "timeout");
          throw error;
        });
        // Azure also reconciles transport usage in the existing budget. Preserve
        // the same fail-closed rule for other existing providers at this adapter.
        if (signal.aborted) throw new ComparisonExecutionError(stage, "timeout");
        if (!Number.isSafeInteger(answer.usage.inputTokens) || answer.usage.inputTokens! < 0 ||
            !Number.isSafeInteger(answer.usage.outputTokens) || answer.usage.outputTokens! < 0 ||
            answer.usage.inputTokens! > 150_000 || answer.usage.outputTokens! > outputTokens) throw new ComparisonExecutionError(stage, "usage_invalid");
        if (options?.azure?.serviceTier === "default" && answer.providerMetadata?.azure?.serviceTier !== "default")
          throw new ComparisonError("ai_incomplete");
        return answer.object;
      };
      const readingSchema = sourceReadingSchemaFor(batch);
      const reading = readingSchema.parse(await generate(SOURCE_ANALYSIS_SYSTEM,
        JSON.stringify(sourceAnalysisInput(batch)), readingSchema, "generation"));
      const analyses = validateSourceAnalysis(batch, reading.sourceAnalysis);
      stage = "generation";
      const prompt = JSON.stringify(batchTransportInput(batch, analyses));
      if (requestBytes(SYSTEM, prompt, batchSchemaFor(batch)) > LIMITS.inputBytes) throw new ComparisonError("ai_incomplete");
      {
        const answer = batchSchema.parse(await generate(SYSTEM, prompt, batchSchemaFor(batch), "generation"));
        const key = (docId: number, p: { baseClaimNo: number; candidateClaimNo: number }) => `${docId}:${p.baseClaimNo}:${p.candidateClaimNo}`;
        const expected = new Set(plan.flatMap(c => c.pairs.map(p => key(c.candidateId, p))));
        const received = answer.results.map(r => key(r.docId, r));
        if (received.length !== expected.size || new Set(received).size !== received.length || received.some(k => !expected.has(k)))
          throw new ComparisonError("ai_incomplete");
        for (const chunk of plan) {
          const own = new Set(chunk.pairs.map(p => key(chunk.candidateId, p)));
          const results = answer.results.filter(r => own.has(key(r.docId, r))).map(r => ({
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
      stage = "review";
      const review = reviewInput(plan, drafts, analyses);
      assertReviewSize(review);
      const rawReview = await generate(REVIEW_SYSTEM, JSON.stringify(reviewTransportInput(review)), reviewTransportSchemaFor(review), "review");
      const decoded = decodeReviewTransport(review, rawReview);
      inspectReviewCoverage(review, decoded);
      try { validateReview(review, decoded); }
      catch { throw new ComparisonExecutionError(stage, "review_rejected"); }
      if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
      const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: new Date().toISOString(),
        inputs, selection, pairs, status: "complete" as const, review: "human_review_required" as const };
      return validateSaved({ ...saved, snapshotDigest: savedDigest(saved) });
    } catch (error) { throw comparisonExecutionFailure(error, stage); }
  });
}
