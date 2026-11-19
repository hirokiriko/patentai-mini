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
import { closedFactInput, reviewSupportInput } from "./closed-fact-input";
import { assertPropositionPlan } from "./proposition-plan";
import { separatedGenerationPlan } from "./source-separation";
import { ComparisonExecutionError, comparisonExecutionFailure, type ComparisonStage } from "./failure";
import { comparisonModelSchema } from "./model-schema";
import { sourceClaimExtractionPlan, assembleSourceClaimsWithLocators } from "./source-claim-extraction";
import { sourceRequestPlan, sourceRequestPieces } from "./source-request-plan";
import { withAiRequestTiming } from "../ai-request-timing";
import { comparisonObservation } from "./observation";

import { generationQuoteOptions } from "./generation-quote-options";
import { sourceAudit, type SourceAuditSink } from "./source-audit";
import { retainReviewFailure, type ReviewFailureStep } from "./review-failure-audit";
import { captureReviewSdkFailure } from "./review-sdk-failure";

export const PROPOSITION_GENERATION_SYSTEM=SYSTEM+`
closedFactsは第一読取の型付き事実から作った完成文候補と請求項依存閉包であり、原文に代わる証明ではない。closed:falseの群は完全な従属条件付き候補として使わない。closed:trueでもclaimsの親請求項条件を省かず、原文と照合して各欄へ完全な具体事実を選ぶ。親の条件付き事実と子の追加事実は同じ欄の独立した文として各主語・全条件・動作を残す。親guardを子guardへ合成せず、別claimの事実・引用位置を一つに結合しない。完成文候補を要約して主語・条件・維持状態を削らない。
出力文は後段で各語句をその文内の根拠へ結び付ける。各文は自立した具体的な技術事実にする。『規定する』『対象とする』『同じ条件』『その条件』『差分は確認できない』『条件方向が異なる』等の照応やメタ総括を加えない。
各断定では基準側・候補側・両側ともで帰属を明示する。側が変わる断定は句点で別文にし、各文に必要な対象・条件・動作を繰り返す。『候補側も』で省略しない。同一条件にも両側の具体的な条件を明示する。
対象・条件・動作は原文の正確な表記を保ち、条件を略記しない。原文にない主語・機能・条件を補わない。例えば『部品は緑色栓を備える。圧力が四を超えると緑色栓を開く。』の観察は『基準側の部品は緑色栓を備える。基準側は圧力が四を超えると緑色栓を開く。』とする。commonもdifferencesも具体的な両側事実で表す。
各断定では原文の技術的な主語を側の印と別に記し、条件の各節を原文どおり残す。『開始する際』を『開始時』へ、『起動する際＋起動後の所定期間』を『起動時』『遷移時』へ短縮しない。維持を開くへ変えない。一文で所有、部品の機能、モードの動作を一つの列挙に混ぜず、所有者と所有物を保つ。文字数内に完全な条件を記せる具体的事実を選び、同じ主語・条件・動作の根拠だけを用いる。長い事実を略して詰め込まない。
baseObservation、candidateObservation、common、differencesの各欄はそれぞれ独立に原文照合される。各観察欄は原則一つの完全な具体事実を選び、120文字内の主語・条件・動作を優先する。別事実の列挙を足すため条件を削らない。各動作を述べる文に技術的主語と適用モード、閾値、起点状態、開始条件、継続期間を残す。別欄の完全な条件でその欄の省略を補わない。文字数に収まらない場合は条件を削らず別の完全な根拠付き事実を選ぶ。必須従属条件を省かず、条件と追加事項の元請求項を区別する。異なる請求項を一つの原文引用範囲として連結しない。
quoteRangesは同じ元請求項の連続原文位置[start,end)で、各IDは側とdigest:文献ID:請求項番号:start:endを表す。baseEvidenceIdとcandidateEvidenceIdには許可されたquoteRanges又はsegmentsのIDを用いる。120文字のsegmentsは全文を保持する分割であり、代表引用の全条件を示すとは限らない。適切なquoteRangesがあれば代表事実の主語・全条件・動作を示すものを優先し、無い条件を短引用に書かれているように扱わない。代表引用だけを全比較断定の完全な証明とせず、その他の断定も全原文と独立した事実・後段照合で検証する。
機器名・モード名を『第１・第２の開閉弁』『第１・第２の運転モード』のような共有接尾辞の列挙へ新たに縮めず、『第１の開閉弁と第２の開閉弁』のように各名称を全文記す。
生成は、まず側・技術的主語・原文の全条件・述語・対象を含む完成文を側ごとに作り、その後に各欄を組み立てる順で行う。同じ事実をcommonやdifferencesへ再利用するときは、その完成文を条件も主語も述語も変えずに使い、共通化のための言い換えをしない。共通なのが部品の存在だけなら、その存在の具体事実を両側について述べ、異なる制御動作を共通の開弁動作へまとめない。
commonとdifferencesでも各文を「基準側の技術的主語は…」「候補側の技術的主語は…」という独立した断定にする。「基準側は…」「候補側は…」だけの文にせず、別欄の主語を借りない。完成文が文字数内に収まらなければ、その事実の主語や条件を短縮せず、別の完全な事実を選ぶ。
common/differencesも要約見出しではない。閾値と比較方向、動作前の状態、起動/停止する動作、継続期間、維持する状態/開度を、その動作と同じ断定に残す。例えば原文が『温度が七度以下に低下した場合、青色弁を開く』なら『温度低下時に青色弁を開く』は条件を失う。『始動後の所定期間、青色弁の開度を所定の大きい値に維持する』を『始動時に青色弁を開弁側に制御する』へ変えない。『青色弁を開いた状態で駆動機を運転している状態から停止する際、停止後も青色弁を開いた状態に維持する』の起点状態を『停止後』へまとめない。原文内の別請求項から条件を移植しない。完全な断定が欄の文字数内に収まるかを先に確かめ、収まらなければ別の完全な根拠付き事実を選ぶ。条件だけ削って収めない。
純粋な未確認事項は『配置は未確認。』のように正確な名詞句＋は未確認。とし、前置きや事実節を含めない。追加の具体的な留保がない場合も完璧・不存在を宣言せず、この試験版で常に必要な人による確認として『比較結果の原文照合は要確認。』と記す。これは条件の省略、断定の弱化、未確認の事実の創作を許可しない。`;

/** One finite serial operation. No fallback and no partial successful save. */
export async function executeComparison(inputs: ComparisonInputs, selection: Selection, auditSink?: SourceAuditSink): Promise<SavedComparison> {
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
      const prompt = JSON.stringify({ ...batchTransportInput(batch, [], quoteOptions), closedFacts: closedFactInput(analyses) });
      if (requestBytes(PROPOSITION_GENERATION_SYSTEM, prompt, batchSchemaFor(batch, quoteOptions)) > LIMITS.inputBytes) throw new ComparisonError("ai_incomplete");
      {
        const answer = batchSchema.parse(await generate(PROPOSITION_GENERATION_SYSTEM, prompt, comparisonModelSchema(batchSchemaFor(batch, quoteOptions)), "generation"));
        generationAnswer = structuredClone(answer);
        reviewStep = "generation_check";
        reviewAnswer = null; // No review send has occurred; preserve the raw generation on rejection.
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
  }), true);
  } finally { observation.close(); }
}
