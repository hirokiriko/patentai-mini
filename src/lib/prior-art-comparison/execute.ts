import { generateObject, NoObjectGeneratedError, type Schema } from "ai";
import { getModel } from "../ai-model";
import { aiOperationDeadline, withPriorArtClaimComparisonBudget } from "../ai-operation-budget";
import { LIMITS, makePlan, savedDigest, SYSTEM, validateAnswer, validateSaved,
  type ComparisonInputs, type SavedComparison, type Selection } from "./comparison";
import { ComparisonError } from "./source";
import { decodeGeneration } from "./generation";
import { batchTransportInput, batchSchema, batchSchemaFor, requestBytes, modelRequestBytes } from "./generation-batch";
import { type ReviewDraft } from "./semantic-review";
import { comparisonProviderOptions } from "./provider-options";
import { comparisonOutputTokens, comparisonRequestMilliseconds, type ComparisonPhase } from "./limits";
import { decodeSourcePropositions, PROPOSITION_TARGET_SYSTEM, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { targetPropositionModelSchemaFor } from "./proposition-locators";
import { assessPropositions, assertPropositionTargetCoverage, renderPropositionDrafts } from "./proposition-result";
import { assertPropositionPlan } from "./proposition-plan";
import { separatedGenerationPlan } from "./source-separation";
import { ComparisonExecutionError, comparisonExecutionFailure, type ComparisonStage } from "./failure";
import { comparisonModelSchema } from "./model-schema";
import { sourceClaimExtractionPlan, assembleSourceClaims } from "./source-claim-extraction";

import { sourceAudit, type SourceAuditSink } from "./source-audit";

export const PROPOSITION_GENERATION_SYSTEM=SYSTEM+"\n各断定では基準側・候補側・両側の帰属を明示し、側が変わる断定を分ける。事実を含む文を未確認の一語で留保扱いにしない。純粋な未確認事項は対象となる名詞句と未確認状態を分けて述べる。これは条件の省略や断定の弱化を許可しない。";

/** One finite serial operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection, auditSink?: SourceAuditSink): Promise<SavedComparison> {
  const plan = makePlan(inputs, selection); // Entire scope must fit before any send.
  const batch = separatedGenerationPlan(plan, PROPOSITION_GENERATION_SYSTEM);
  assertPropositionPlan(batch);
  const sourcePlan = sourceClaimExtractionPlan(batch);
  return withPriorArtClaimComparisonBudget(sourcePlan.tasks.length, async absolute => {
    const drafts: ReviewDraft[] = [];
    let stage: ComparisonStage = "source_reading";
    try {
      const generate = async (system: string, prompt: string, schema: Schema<unknown>, phase: ComparisonPhase, sourceTaskId?: string) => {
        if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
        const model = getModel();
        const options = comparisonProviderOptions(model, phase);
        const outputTokens = comparisonOutputTokens(model, phase);
        const signal = AbortSignal.any([absolute, aiOperationDeadline(comparisonRequestMilliseconds(model, phase))]);
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
      for (const task of sourcePlan.tasks) {
        try {
          const value = await generate(task.system, task.prompt, task.schema, "source", task.id);
          pieces.push({ taskId: task.id, value });
        } catch (error) {
          // Retain completed prefix and bounded model text only; never transport
          // headers, credentials, error messages or inferred/repaired answers.
          await persistAudit(NoObjectGeneratedError.isInstance(error) && typeof error.text === "string"
            ? { taskId: task.id, text: error.text } : undefined);
          throw error;
        }
      }
      // Commit ACK is mandatory before generation. Assembly/domain rejection
      // still leaves all original structured objects available to OWNER QA.
      await persistAudit();
      const reading = await assembleSourceClaims(sourcePlan, pieces);
      const analyses = decodeSourcePropositions(batch, reading);
      stage = "generation";
      const prompt = JSON.stringify(batchTransportInput(batch));
      if (requestBytes(PROPOSITION_GENERATION_SYSTEM, prompt, batchSchemaFor(batch)) > LIMITS.inputBytes) throw new ComparisonError("ai_incomplete");
      {
        const answer = batchSchema.parse(await generate(PROPOSITION_GENERATION_SYSTEM, prompt, comparisonModelSchema(batchSchemaFor(batch)), "generation"));
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
          for (const p of verified) {
            const r = results.find(r => r.baseClaimNo === p.baseClaimNo && r.candidateClaimNo === p.candidateClaimNo)!;
            drafts.push({ ...p, baseObservation: r.baseObservation, candidateObservation: r.candidateObservation });
          }
        }
      }
      stage = "review";
      const review = propositionTargetInput(plan, drafts, analyses);
      const schema = targetPropositionModelSchemaFor(review), targetPrompt=JSON.stringify(propositionTargetTransport(review));
      if(modelRequestBytes(PROPOSITION_TARGET_SYSTEM,targetPrompt,schema)>LIMITS.inputBytes)throw new ComparisonError("ai_incomplete");
      const rawReview = await generate(PROPOSITION_TARGET_SYSTEM,targetPrompt,schema,"review");
      const assessed = assessPropositions(review,rawReview);
      let rendered:ReviewDraft[];
      try { assertPropositionTargetCoverage(review,assessed);rendered=renderPropositionDrafts(review,assessed,drafts); }
      catch { throw new ComparisonExecutionError(stage, "review_rejected"); }
      // Re-validate the generated sentences and original literal quotes through
      // the unchanged save-v1 adapter. No old free-form verdict reaches save.
      const finalPairs=plan.flatMap(chunk=>validateAnswer(chunk,{results:rendered.filter(d=>d.docId===chunk.candidateId&&
        chunk.pairs.some(p=>p.baseClaimNo===d.baseClaimNo&&p.candidateClaimNo===d.candidateClaimNo)).map(d=>({
          baseClaimNo:d.baseClaimNo,candidateClaimNo:d.candidateClaimNo,common:d.common,differences:d.differences,unconfirmed:d.unconfirmed,
          baseEvidence:{claimNo:d.baseEvidence.claimNo,quote:d.baseEvidence.quote},candidateEvidence:{claimNo:d.candidateEvidence.claimNo,quote:d.candidateEvidence.quote},
        }))}));
      if (absolute.aborted) throw new ComparisonExecutionError(stage, "timeout");
      const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: new Date().toISOString(),
        inputs, selection, pairs:finalPairs, status: "complete" as const, review: "human_review_required" as const };
      return validateSaved({ ...saved, snapshotDigest: savedDigest(saved) });
    } catch (error) { throw comparisonExecutionFailure(error, stage); }
  });
}
