import { parseComparisonSource } from "./source";
import { makePlan, savedDigest, validateAnswer, type ComparisonInputs, type Selection, type SavedComparison } from "./comparison";
import type { generationInput } from "./generation";
import type { batchInput } from "./generation-batch";
import { reviewTargetIdentity, reviewTargetUnits, type reviewInput } from "./semantic-review";
import { reviewReferenceMentions, type ReferenceRelationCheck } from "./reference-mentions";
import type { reviewTransportInput } from "./review-transport";
export function fictionalInputs() {
  // Keep the decisive tail beyond 15,000 while reserving the unchanged wire
  // budget for the source-analysis schema and maximum possible review draft.
  const body = "架空の温度制御装置は、各区域の測定値を保持する。".repeat(630);
  const draftText = `【請求項1】\n${body}末尾条件は温度が七度を超えると青色弁を閉じることである。\n【請求項2】\n請求項1に記載の装置であって、確認値を翌朝に消去する装置。`;
  const candidate = (last: string) => `【請求項1】\n${"架空の温度制御装置は、各区域の測定値を保持する。".repeat(100)}${last}\n【請求項2】\n請求項1に記載の装置であって、確認値を翌朝に消去する装置。`;
  const inputs: ComparisonInputs = { caseId: 7, title: "完全架空・温度調整の指定比較", inputDigest: "a".repeat(64),
    draft: parseComparisonSource(draftText, 11, "draft-11"),
    documents: [parseComparisonSource(candidate("末尾条件は温度が七度を超えると青色弁を閉じることである。"), 21, "FICTIONAL-A"),
      parseComparisonSource(candidate("末尾条件は温度が七度を下回ると青色弁を開くことである。"), 22, "FICTIONAL-B")] };
  const selection: Selection = { operationId: "a0000000-0000-4000-8000-000000000001", inputDigest: inputs.inputDigest,
    draftClaimNos: [1], draftIdentity: { publication: "架空基準", edition: "架空版1" },
    documents: inputs.documents.map(d => ({ docId: d.id, claimNos: [1], identity: { publication: d.label, edition: "架空版1" } })), originalsConfirmed: true };
  return { inputs, selection };
}
export function fictionalAnswer(chunk: ReturnType<typeof makePlan>[number]) {
  return { results: chunk.pairs.map(p => ({ ...p,
    common: "引用した箇所はどちらも温度の条件に応じて青色弁を動作させる。",
    differences: chunk.candidateId === 22 ? "引用箇所は基準の超過・閉動作に対し、文献では低下・開動作である。" : "引用した末尾条件に差は確認できない。",
    unconfirmed: "装置全体の作用と図面は未確認。",
    baseEvidence: { claimNo: p.baseClaimNo, quote: chunk.base.claims.find(c => c.claimNo === p.baseClaimNo)!.text.split("。").filter(Boolean).at(-1)! + "。" },
    candidateEvidence: { claimNo: p.candidateClaimNo, quote: chunk.candidate.claims.find(c => c.claimNo === p.candidateClaimNo)!.text.split("。").filter(Boolean).at(-1)! + "。" },
  })) };
}
export function fictionalGeneration(chunk: ReturnType<typeof generationInput>) {
  const evidence = (source: typeof chunk.base, claimNo: number) => source.claims.find(c => c.claimNo === claimNo)!.segments.filter(s => s.quotable).at(-1)!.id;
  return { results: chunk.pairs.map(p => ({ baseClaimNo: p.baseClaimNo, candidateClaimNo: p.candidateClaimNo,
    baseEvidenceId: evidence(chunk.base, p.baseClaimNo), candidateEvidenceId: evidence(chunk.candidate, p.candidateClaimNo),
    baseObservation: "基準の末尾条件は七度を超えると青色弁を閉じる。",
    candidateObservation: chunk.candidateId === 22 ? "候補の末尾条件は七度を下回ると青色弁を開く。" : "候補の末尾条件は七度を超えると青色弁を閉じる。",
    common: "引用した箇所はどちらも温度の条件に応じて青色弁を動作させる。",
    differences: chunk.candidateId === 22 ? "引用箇所は基準の超過・閉動作に対し、文献では低下・開動作である。" : "引用した末尾条件に差は確認できない。",
    unconfirmed: "装置全体の作用と図面は未確認。",
  })) };
}
export function fictionalBatch(input: ReturnType<typeof batchInput>) {
  return { results: input.documents.flatMap(d => fictionalGeneration({ ...d, base: input.base }).results.map(r => ({ ...r, docId: d.candidateId }))) };
}
export function fictionalReview(input: ReturnType<typeof reviewInput>) {
  return { draftDigest: input.draftDigest,
    checks: input.targets.map(t => {
      const identity = reviewTargetIdentity(t.id);
      const ids = [
        ...(identity.field === "candidateObservation" ? [] : [input.base.claims.find(c => c.claimNo === identity.baseClaimNo)!.segments.at(-1)![0]]),
        ...(identity.field === "baseObservation" ? [] : [input.documents.find(d => d.docId === identity.docId)!.source.claims.find(c => c.claimNo === identity.candidateClaimNo)!.segments.at(-1)![0]]),
      ];
      return { id: t.id, unitChecks: reviewTargetUnits(t.text).map(unit => ({ start: unit.start,
        referenceChecks: reviewReferenceMentions(t.text).filter(m => m.start >= unit.start && m.end <= unit.end)
          .map(m => ({ start: m.start, relation: "unspecified", operatorBasis: null }) as ReferenceRelationCheck),
        contrasts: [{ end: unit.end, kind: "technical" as "technical" | "reference_scope" | "reference_combination", referenceStart: null as number | null,
          evidenceIds: [...ids], sourceComparison: "架空原文との対応。意味品質の実証ではない。",
          verdict: "consistent" as "consistent" | "inconsistent" | "uncertain", rejectedTargetSpan: null as [number, number] | null }] })) };
    }) };
}
/** Fictional raw transport only; never evidence of semantic quality. */
export function fictionalTransportReview(input: ReturnType<typeof reviewTransportInput>) {
  const lastEvidence = (source: typeof input.base, claimNo: number) => {
    return source.claims.find(c => c[0] === claimNo)![2].at(-1)![0];
  };
  return { draftDigest: input.draftDigest,
    referenceChecks: input.units.flatMap(unit => (typeof unit === "string" ? [] : unit.filter((_, part) => part % 2 === 1)))
      .map(() => ({ relation: "unspecified" as const, operatorBasis: null })),
    checks: input.fields.flatMap(([id, firstUnitId, endUnitId]) => {
    const identity = reviewTargetIdentity(id);
    const ids = [
      ...(identity.field === "candidateObservation" ? [] : [lastEvidence(input.base, identity.baseClaimNo)]),
      ...(identity.field === "baseObservation" ? [] : [lastEvidence(input.documents.find(d => d.docId === identity.docId)!.source, identity.candidateClaimNo)]),
    ];
    return input.units.slice(firstUnitId, endUnitId).map((unit, index) => ({ unitId: firstUnitId + index,
      sourceReading: "架空原文の条件。意味品質の実証ではない。", assertion: "fact" as const, counterEvidence: null,
      kind: "technical" as "technical" | "reference_scope" | "reference_combination", reference: null as number | null,
      evidenceIds: [...ids], sourceComparison: "架空原文との対応。意味品質の実証ではない。",
      verdict: "consistent" as "consistent" | "inconsistent" | "uncertain", scopeWitness: null,
    }));
  }) };
}
export function fictionalSaved(): SavedComparison {
  const { inputs, selection } = fictionalInputs();
  const pairs = makePlan(inputs, selection).flatMap(c => validateAnswer(c, fictionalAnswer(c)));
  const saved = { version: 1 as const, operationId: selection.operationId, generatedAt: "2026-10-16T06:00:00.000Z", inputs, selection, pairs,
    status: "complete" as const, review: "human_review_required" as const };
  return { ...saved, snapshotDigest: savedDigest(saved) };
}
