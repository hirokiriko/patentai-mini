import { generateObject, NoObjectGeneratedError, type Schema } from "ai";
import { getModel } from "../ai-model";
import { aiOperationDeadline, withPriorArtClaimComparisonBudget, type ComparisonSpendAllocation } from "../ai-operation-budget";
import { LIMITS, makePlan, savedDigest, validateAnswer, validateSaved,
  type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { ComparisonError } from "./source";
import { decodeGeneration } from "./generation";
import { batchTransportInput, modelRequestBytes } from "./generation-batch";
import { type ReviewDraft } from "./semantic-review";
import { comparisonProviderOptions } from "./provider-options";
import { comparisonOutputTokens, comparisonRequestMilliseconds, type ComparisonPhase } from "./limits";
import { decodeSourcePropositions, PROPOSITION_TARGET_SYSTEM, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { targetPropositionModelSchemaFor } from "./proposition-locators";
import { assessPropositions, assertPropositionTargetCoverage, renderPropositionDrafts } from "./proposition-result";
import { closedFactInput, reviewSupportInput } from "./closed-fact-input";
import { assertPropositionPlan } from "./proposition-plan";
import { separatedGenerationPlan } from "./source-separation";
import { ComparisonExecutionError, comparisonExecutionFailure, type ComparisonStage } from "./failure";
import { comparisonModelSchema } from "./model-schema";
import { sourceClaimExtractionPlan, assembleSourceClaimsWithLocators } from "./source-claim-extraction";
import { sourceRequestPlan, sourceRequestPieces } from "./source-request-plan";
import { withAiRequestTiming } from "../ai-request-timing";
import { comparisonObservation } from "./observation";

import { decodeFactSelection, generationSelectionSchema, factSelectionSchema, factObservationChoices, factControlCoverage } from "./fact-selection-generation";
import { generationQuoteOptions } from "./generation-quote-options";
import { sourceAudit, type SourceAuditSink } from "./source-audit";
import { retainReviewFailure, type ReviewFailureStep } from "./review-failure-audit";
import { captureReviewSdkFailure } from "./review-sdk-failure";

export const PROPOSITION_GENERATION_SYSTEM = `Select complete existing fact IDs from closedFacts for each planned pair. Return only the structured selections, never patent prose. baseFacts/candidateFacts are scoped observations and their first fact supplies the representative original quote. Choose observations from observationChoices, first citing the selected claim when it has an own source fact. Passive is_state/power_ends facts retain their legitimate absent actor. Cover each requiredControlChoices group with at least one existing complete fact across the fields, keeping parent and child separate. Choose complete quote ranges. common pairs must have exactly the same complete meaning on both sides, including subject, context, guards and predicate, or an existing explicit set-member correspondence whose separate quantifiers remain printed. differences selects distinct complete facts from each side, or a nominal reservation object when no supported difference is established. Never label identical facts as differences; never compose parent and child conditions into one fact. All original claims and facts remain available. The server writes the exact complete subject, conditions and action, and independent review still checks the reading against original sources. For budgeted differences, select each side's exact JSON-encoded fact-ID bundle from the schema enums; these bundles preserve complete facts and the combined200 UTF16 limit. Other selections retain their existing arrays. Select a different complete fact if the rendered observation exceeds120 UTF16 units or paired common/differences exceeds200; never shorten a fact. unconfirmed contains nominal uncertainty topics only, e.g. 比較結果の原文照合は要確認。`;

/** One finite serial operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection, auditSink?: SourceAuditSink,
  allocation?: ComparisonSpendAllocation): Promise<SavedComparison> {
  const plan = makePlan(inputs, selection); // Entire scope must fit before any send.
  const batch = separatedGenerationPlan(plan, PROPOSITION_GENERATION_SYSTEM);
  assertPropositionPlan(batch);
  const sourcePlan = sourceClaimExtractionPlan(batch);
  const sourceRequests = sourceRequestPlan(sourcePlan);
  const observation = comparisonObservation(selection.operationId);
  try {
  return await withAiRequestTiming(timing => observation.emit("request_timing", { timing,
    stage: timing.attempt <= sourceRequests.length ? "source_reading" : timing.attempt === sourceRequests.length + 1 ? "generation" : "review" }),
  () => withPriorArtClaimComparisonBudget(sourceRequests.length, async absolute => {
    const drafts: ReviewDraft[] = [];
    let stage: ComparisonStage = "source_reading";
    let reviewStep: ReviewFailureStep | undefined;
    let generationAnswer: unknown, reviewAnswer: unknown;
    try {
      observation.emit("source_started", { stage, tasks: sourcePlan.tasks.length });
      const generate = async (system: string, prompt: string, schema: Schema<unknown>, phase: ComparisonPhase, sourceTaskId?: string, partitionedSource?: boolean, outputTokenLimit?: number) => {
        if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
        const model = getModel();
        if (allocation && (model.provider !== "azure.responses" || model.modelId !== "patentai-gpt54")) throw new ComparisonError("ai_incomplete");
        const options = comparisonProviderOptions(model, phase, partitionedSource);
        const outputTokens = Math.min(comparisonOutputTokens(model, phase), outputTokenLimit ?? Infinity);
        const signal = AbortSignal.any([absolute, aiOperationDeadline(comparisonRequestMilliseconds(model, phase))]);
        const answer = await generateObject({ model, schema,
          system, prompt, maxRetries: 0,
          maxOutputTokens: outputTokens, abortSignal: signal,
          ...(options ? { providerOptions: options } : {}),
        }).catch(error => {
          if (signal.aborted) throw new ComparisonExecutionError(stage, "timeout");
          if (phase === "review") {
            const diagnostic = captureReviewSdkFailure(error);
            if (diagnostic) { reviewStep = "sdk_object"; reviewAnswer = diagnostic; }
          }
          throw error;
        });
        // A syntactically complete object can still accompany a provider's
        // truncated response. It must not authorize adopting either member.
        if (answer.finishReason !== "stop") throw new ComparisonExecutionError(stage, "output_incomplete");
        // Azure also reconciles transport usage in the existing budget. Preserve
        // the same fail-closed rule for other existing providers at this adapter.
        if (signal.aborted) throw new ComparisonExecutionError(stage, "timeout");
        if (!Number.isSafeInteger(answer.usage.inputTokens) || answer.usage.inputTokens! < 0 ||
            !Number.isSafeInteger(answer.usage.outputTokens) || answer.usage.outputTokens! < 0 ||
            answer.usage.inputTokens! > 150_000 || answer.usage.outputTokens! > outputTokens) throw new ComparisonExecutionError(stage, "usage_invalid");
        if (options?.azure?.serviceTier === "default" && answer.providerMetadata?.azure?.serviceTier !== "default")
          throw new ComparisonError("ai_incomplete");
        // Correlate reconciled usage with the saved operation without logging
        // source text, prompts, results, case identity or provider credentials.
        // Missing logs never justify treating an unknown send as zero cost.
        try {
          console.info("prior_art_comparison_usage", JSON.stringify({ operationId: selection.operationId,
            phase, ...(sourceTaskId ? { sourceTaskId } : {}), inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens, status: "reconciled" }));
        } catch { /* Optional observation must not change the comparison. */ }
        return answer.object;
      };
      const pieces: { taskId: string; value: unknown }[] = [];
      const persistAudit = async (failure?: { taskId: string; text: string }) => {
        if (!auditSink) return;
        try { await auditSink(sourceAudit(selection.operationId, inputs.inputDigest, sourcePlan.tasks, pieces, failure)); }
        catch { throw new ComparisonExecutionError("source_reading", "transport_unknown"); }
      };
      for (const request of sourceRequests) {
        try {
          const value = await generate(request.system, request.prompt, request.schema, "source", request.id, request.partitioned, request.outputTokenLimit);
          pieces.push(...await sourceRequestPieces(request, value));
        } catch (error) {
          // Retain completed prefix and bounded model text only; never transport
          // headers, credentials, error messages or inferred/repaired answers.
          await persistAudit(NoObjectGeneratedError.isInstance(error) && typeof error.text === "string"
            ? { taskId: request.tasks[0].id, text: error.text } : undefined);
          throw error;
        }
      }
      // Commit ACK is mandatory before generation. Assembly/domain rejection
      // still leaves all original structured objects available to OWNER QA.
      await persistAudit();
      const reading = await assembleSourceClaimsWithLocators(sourcePlan, pieces);
      const analyses = decodeSourcePropositions(batch, reading.extraction, reading.locators);
      stage = "generation";
      observation.emit("generation_started", { stage });
      const quoteOptions = generationQuoteOptions(batch, analyses);
      const observationChoices = factObservationChoices(batch, analyses, quoteOptions);
      const requiredControlChoices = factControlCoverage(analyses);
      const selectionShape = generationSelectionSchema(batch, analyses, observationChoices, requiredControlChoices);
      const selectionSchema = comparisonModelSchema<unknown>(selectionShape);
      const prompt = JSON.stringify({ ...batchTransportInput(batch, [], quoteOptions), generationProtocol: "scoped_fact_selection_v1",
        ...(selectionShape === factSelectionSchema ? {} : { resultLayout: "Fill every required results property. Its name identifies the document, base claim and candidate claim." }),
        closedFacts: closedFactInput(analyses), observationChoices, requiredControlChoices });
      if (modelRequestBytes(PROPOSITION_GENERATION_SYSTEM, prompt, selectionSchema) > LIMITS.inputBytes) throw new ComparisonError("ai_incomplete");
      {
        const selectionAnswer = await generate(PROPOSITION_GENERATION_SYSTEM, prompt, selectionSchema, "generation");
        generationAnswer = structuredClone(selectionAnswer);
        reviewStep = "generation_check";
        reviewAnswer = null; // No review send has occurred; preserve the raw generation on rejection.
        const answer = decodeFactSelection(batch, analyses, quoteOptions, selectionAnswer);
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
          const verified = validateAnswer(chunk, decodeGeneration(chunk, { results }, quoteOptions));
          for (const p of verified) {
            const r = results.find(r => r.baseClaimNo === p.baseClaimNo && r.candidateClaimNo === p.candidateClaimNo)!;
            drafts.push({ ...p, baseObservation: r.baseObservation, candidateObservation: r.candidateObservation });
          }
        }
      }
      stage = "review";
      observation.emit("review_started", { stage });
      const review = propositionTargetInput(plan, drafts, analyses);
      const schema = targetPropositionModelSchemaFor(review), targetPrompt=JSON.stringify({ ...propositionTargetTransport(review), supportSelection: reviewSupportInput(review) });
      if(modelRequestBytes(PROPOSITION_TARGET_SYSTEM,targetPrompt,schema)>LIMITS.inputBytes)throw new ComparisonError("ai_incomplete");
      const rawReview = await generate(PROPOSITION_TARGET_SYSTEM,targetPrompt,schema,"review");
      reviewAnswer = structuredClone(rawReview);
      reviewStep = "assessment";
      const assessed = assessPropositions(review,rawReview);
      let rendered:ReviewDraft[];
      reviewStep = "coverage_render";
      try { assertPropositionTargetCoverage(review,assessed);rendered=renderPropositionDrafts(review,assessed,drafts); }
      catch { throw new ComparisonExecutionError(stage, "review_rejected"); }
      // Re-validate the generated sentences and original literal quotes through
      // the unchanged save-v1 adapter. No old free-form verdict reaches save.
      reviewStep = "final_answer";
      const finalPairs=plan.flatMap(chunk=>validateAnswer(chunk,{results:rendered.filter(d=>d.docId===chunk.candidateId&&
        chunk.pairs.some(p=>p.baseClaimNo===d.baseClaimNo&&p.candidateClaimNo===d.candidateClaimNo)).map(d=>({
          baseClaimNo:d.baseClaimNo,candidateClaimNo:d.candidateClaimNo,common:d.common,differences:d.differences,unconfirmed:d.unconfirmed,
          baseEvidence:{claimNo:d.baseEvidence.claimNo,quote:d.baseEvidence.quote},candidateEvidence:{claimNo:d.candidateEvidence.claimNo,quote:d.candidateEvidence.quote},
        }))}));
      if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
      const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: new Date().toISOString(),
        inputs, selection, pairs:finalPairs, status: "complete" as const, review: "human_review_required" as const };
      reviewStep = "saved_envelope";
      const validated = validateSaved({ ...saved, snapshotDigest: savedDigest(saved) });
      observation.emit("execution_completed", { stage });
      return validated;
    } catch (error) {
      const failure = comparisonExecutionFailure(error, stage);
      observation.emit("execution_rejected", { stage: failure.stage, kind: failure.kind });
      if (reviewStep) retainReviewFailure(failure, { step: reviewStep, inputs, selection, generation: generationAnswer, review: reviewAnswer });
      throw failure;
    }
  }, false, allocation), true);
  } finally { observation.close(); }
}
