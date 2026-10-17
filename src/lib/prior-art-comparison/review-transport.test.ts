import { describe, expect, it } from "vitest";
import { makePlan, validateAnswer } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalReview } from "./fixtures.test-support";
import { inspectReviewCoverage, reviewInput, reviewTargetUnits, validateReview } from "./semantic-review";
import { reviewReferenceMentions } from "./reference-mentions";
import { decodeReviewTransport, REVIEW_TRANSPORT_SYSTEM, reviewTransportInput, reviewTransportSchemaFor } from "./review-transport";
import { parseComparisonSource } from "./source";
import { requestBytes } from "./generation-batch";
import { managedClaimContext, planManagedComparisons } from "../patent-watch/managed-claims";

function example(candidateClaimNo = 1) {
  const { inputs, selection } = fictionalInputs();
  const body = "【請求項1】\n主装置は光を備え、補助装置は音又は振動を備える。\n【請求項2】\n請求項1に記載の装置であって、記録を保持する。";
  inputs.draft = parseComparisonSource(body, 11, "draft");
  inputs.documents = [21, 22, 23].map(id => parseComparisonSource(body, id, `架空-${id}`));
  selection.documents = inputs.documents.map(d => ({ docId: d.id, claimNos: [candidateClaimNo], identity: { publication: d.label, edition: "架空" } }));
  const plan = makePlan(inputs, selection);
  const drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({ ...p,
    baseObservation: "主装置は光が必須。補助装置は音又は振動。", candidateObservation: "候補条件。" })));
  return { plan, drafts, logical: reviewInput(plan, drafts) };
}

/** Fictional protocol responses only; these reasons are not semantic evidence. */
function response(logical: ReturnType<typeof reviewInput>) {
  let unitId = 0;
  return { draftDigest: reviewTransportInput(logical).draftDigest, checks: logical.targets.flatMap(target => {
    const [doc, base, candidate, field] = target.id.split(":");
    const ids = [...(field === "candidateObservation" ? [] : [logical.base.claims.find(c => c.claimNo === Number(base))!.segments[0][0]]),
      ...(field === "baseObservation" ? [] : [logical.documents.find(d => d.docId === Number(doc))!.source.claims.find(c => c.claimNo === Number(candidate))!.segments[0][0]])];
    return reviewTargetUnits(target.text).map(unit => ({ unitId: unitId++,
      referenceChecks: reviewReferenceMentions(target.text).filter(m => m.start >= unit.start && m.end <= unit.end)
        .map(() => ({ relation: "unspecified" as "unspecified" | "all" | "any" | "unresolved", operatorBasis: null as { quote: "全て" | "又は"; occurrence: number } | null })),
      kind: "technical" as "technical" | "reference_scope" | "reference_combination", reference: null as number | null,
      evidenceIds: ids, sourceComparison: "架空原文との対応。意味品質の実証ではない。",
      verdict: "consistent" as "consistent" | "inconsistent" | "uncertain",
      scopeWitness: null as { scopeId: string; invalidMember: number; mode: "ancestor" | "direct"; subjectReference: number | null; directnessBasis: { word: "直接"; occurrence: number } | null } | null }));
  }) };
}

describe("whole-unit review transport", () => {
  it("keeps every source, scope, pair and field unchanged while numbering all units once", () => {
    const { logical } = example(), input = reviewTransportInput(logical);
    expect(input.task).toBe("review"); expect(input.draftDigest).not.toBe(logical.draftDigest);
    expect(input.base).toBe(logical.base); expect(input.documents).toBe(logical.documents);
    expect(input.scopes).toBe(logical.scopes); expect(input.pairs).toBe(logical.pairs);
    const ids = input.targets.flatMap(t => t.unitIds);
    expect(ids).toEqual(ids.map((_, i) => i));
    input.targets.forEach((target, i) => {
      expect(target.text).toBe(logical.targets[i].text);
      expect(target.unitIds).toHaveLength(reviewTargetUnits(target.text).length);
      expect(target).not.toHaveProperty("unitStarts"); expect(target).not.toHaveProperty("contrastCuts");
    });
    const raw = response(logical), before = JSON.stringify(raw), decoded = decodeReviewTransport(logical, raw);
    expect(decoded.draftDigest).toBe(logical.draftDigest);
    expect(inspectReviewCoverage(logical, decoded).checks).toHaveLength(logical.targets.length);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it.each(["missing", "extra", "duplicate", "reordered", "foreign", "wrong_digest", "logical_digest", "legacy_root", "legacy_row", "missing_witness", "blank_reason", "control", "fraction_id", "string_id", "unsafe_evidence"])("strictly refuses %s raw coverage", mode => {
    const { logical } = example(), raw = response(logical);
    if (mode === "missing") raw.checks.pop();
    if (mode === "extra") raw.checks.push({ ...raw.checks[0] });
    if (mode === "duplicate") raw.checks[1].unitId = raw.checks[0].unitId;
    if (mode === "reordered") [raw.checks[0], raw.checks[1]] = [raw.checks[1], raw.checks[0]];
    if (mode === "foreign") raw.checks[0].unitId = raw.checks.length;
    if (mode === "wrong_digest") raw.draftDigest = "f".repeat(64);
    if (mode === "logical_digest") raw.draftDigest = logical.draftDigest;
    if (mode === "legacy_root") Object.assign(raw, { sourceFacts: [] });
    if (mode === "legacy_row") Object.assign(raw.checks[0], { start: 0 });
    if (mode === "missing_witness") delete (raw.checks[0] as Partial<typeof raw.checks[0]>).scopeWitness;
    if (mode === "blank_reason") raw.checks[0].sourceComparison = "　 ";
    if (mode === "control") raw.checks[0].sourceComparison = "前半\n後半";
    if (mode === "fraction_id") raw.checks[0].unitId = 0.5;
    if (mode === "string_id") Object.assign(raw.checks[0], { unitId: "0" });
    if (mode === "unsafe_evidence") raw.checks[0].evidenceIds = [Number.MAX_SAFE_INTEGER + 1];
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("refuses old nested wire and a derived report as new raw", () => {
    const { logical } = example();
    expect(() => decodeReviewTransport(logical, fictionalReview(logical))).toThrow("ai_incomplete");
    const decoded = decodeReviewTransport(logical, response(logical));
    expect(() => decodeReviewTransport(logical, decoded)).toThrow("ai_incomplete");
    expect(() => decodeReviewTransport(logical, inspectReviewCoverage(logical, decoded))).toThrow("ai_incomplete");
  });

  it("derives every complete Unicode unit without offsets, split conclusions or generated quotes", () => {
    const { plan, drafts } = example();
    drafts[0].differences = "𠮷の温度が上限を超えた場合、制御を実行しない。　次の条件。。末尾。　";
    const logical = reviewInput(plan, drafts), raw = response(logical), target = logical.targets[3], units = reviewTargetUnits(target.text);
    const ids = reviewTransportInput(logical).targets[3].unitIds;
    for (const id of ids) raw.checks[id].verdict = "inconsistent";
    const decoded = decodeReviewTransport(logical, raw), checks = decoded.checks[3].unitChecks;
    expect(checks.map(c => target.text.slice(...c.contrasts[0].rejectedTargetSpan!)).join("")).toBe(target.text);
    checks.forEach((check, i) => {
      expect(check.start).toBe(units[i].start); expect(check.contrasts).toHaveLength(1);
      expect(check.contrasts[0].end).toBe(units[i].end);
      expect(check.contrasts[0].rejectedTargetSpan).toEqual([units[i].start, units[i].end]);
    });
    expect(checks[0].contrasts[0].rejectedTargetSpan).toEqual([0, units[0].end]);
    expect(target.text.slice(0, units[0].end)).toContain("上限を超えた場合、制御を実行しない");
    expect(inspectReviewCoverage(logical, decoded).checks[3].verdict).toBe("inconsistent");
    expect(() => validateReview(logical, decoded)).toThrow("ai_incomplete");
  });

  it("keeps a full legal 200-unit review rejection while generation quote coordinates stay untouched", () => {
    const { plan, drafts } = example(), evidence = structuredClone(drafts[0].baseEvidence);
    drafts[0].differences = "甲".repeat(198) + "乙。";
    const logical = reviewInput(plan, drafts), raw = response(logical), id = reviewTransportInput(logical).targets[3].unitIds[0];
    raw.checks[id].verdict = "inconsistent";
    const decoded = decodeReviewTransport(logical, raw);
    expect(decoded.checks[3].unitChecks[0].contrasts[0].rejectedTargetSpan).toEqual([0, 200]);
    expect(inspectReviewCoverage(logical, decoded).checks[3].rejectedTargetAnchor?.quote).toBe(drafts[0].differences);
    expect(drafts[0].baseEvidence).toEqual(evidence); expect(evidence.quote.length).toBeLessThanOrEqual(120);
  });

  function referenceExample(text = "全ての弁が閉じ、請求項1-2の全てを備える。") {
    const { plan, drafts } = example(); drafts[0].baseObservation = text;
    const logical = reviewInput(plan, drafts), raw = response(logical);
    return { logical, raw, first: raw.checks[0] };
  }

  it("zips reference occurrence order and resolves a literal quantifier's nth occurrence locally", () => {
    const { logical, raw, first } = referenceExample();
    first.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
    first.kind = "reference_combination"; first.reference = 1;
    const decoded = decodeReviewTransport(logical, raw), check = decoded.checks[0].unitChecks[0];
    expect(check.referenceChecks[0].start).toBe(logical.targets[0].text.indexOf("請求項"));
    expect(check.referenceChecks[0].operatorBasis).toEqual({ quote: "全て", start: logical.targets[0].text.lastIndexOf("全て") });
    expect(check.contrasts[0].referenceStart).toBe(check.referenceChecks[0].start);
    expect(check.contrasts[0].rejectedTargetSpan).toBeNull();
    expect(() => validateReview(logical, decoded)).not.toThrow();
  });

  it.each(["missing", "extra", "zero", "fraction", "unsafe", "nonexistent", "wrong_relation", "basis_for_unspecified", "technical_reference", "null_reference", "foreign_reference", "unresolved_c"])("refuses %s reference binding", mode => {
    const { logical, raw, first } = referenceExample();
    first.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
    if (mode === "missing") first.referenceChecks.pop();
    if (mode === "extra") first.referenceChecks.push({ ...first.referenceChecks[0] });
    if (mode === "zero") first.referenceChecks[0].operatorBasis!.occurrence = 0;
    if (mode === "fraction") first.referenceChecks[0].operatorBasis!.occurrence = 1.5;
    if (mode === "unsafe") first.referenceChecks[0].operatorBasis!.occurrence = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "nonexistent") first.referenceChecks[0].operatorBasis!.occurrence = 3;
    if (mode === "wrong_relation") first.referenceChecks[0].relation = "any";
    if (mode === "basis_for_unspecified") first.referenceChecks[0].relation = "unspecified";
    if (mode === "technical_reference") first.reference = 1;
    if (mode === "null_reference") first.kind = "reference_scope";
    if (mode === "foreign_reference") { first.kind = "reference_scope"; first.reference = 2; }
    if (mode === "unresolved_c") first.referenceChecks[0] = { relation: "unresolved", operatorBasis: null };
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("counts basis occurrences inside this unit only", () => {
    const { logical, raw } = referenceExample("全ての弁を備える。請求項1-2の全てを備える。");
    raw.checks[1].referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    raw.checks[1].referenceChecks[0].operatorBasis!.occurrence = 1;
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[1].referenceChecks[0].operatorBasis?.start)
      .toBe(logical.targets[0].text.lastIndexOf("全て"));
  });

  it("binds multiple references in their exact Unicode source order", () => {
    const { logical, raw, first } = referenceExample("𠮷の装置は、請求項１の全て、又は請求項２の装置を備える。");
    first.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 1 } };
    first.referenceChecks[1] = { relation: "any", operatorBasis: { quote: "又は", occurrence: 1 } };
    const checks = decodeReviewTransport(logical, raw).checks[0].unitChecks[0].referenceChecks;
    expect(checks.map(c => c.start)).toEqual(reviewReferenceMentions(logical.targets[0].text).map(m => m.start));
    expect(checks.map(c => c.operatorBasis?.start)).toEqual([logical.targets[0].text.indexOf("全て"), logical.targets[0].text.indexOf("又は")]);
  });

  it.each(["consistent", "inconsistent", "uncertain"] as const)("does not promote an unspecified combination to %s", verdict => {
    const { logical, raw, first } = referenceExample("請求項1-2の装置は、温度上限で停止する。");
    first.kind = "reference_combination"; first.reference = 1; first.verdict = verdict;
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    first.kind = "technical"; first.reference = null;
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[0].contrasts[0].verdict).toBe(verdict);
  });

  it("requires a validated numeric scope witness only for a scope I", () => {
    const { plan, drafts } = example(2); drafts[0].candidateObservation = "候補側は請求項3の装置を継承する。";
    const logical = reviewInput(plan, drafts), raw = response(logical), id = reviewTransportInput(logical).targets[1].unitIds[0], answer = raw.checks[id];
    answer.kind = "reference_scope"; answer.reference = 1; answer.verdict = "inconsistent";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.scopeWitness = { scopeId: "candidate:21:2", invalidMember: 3, mode: "ancestor", subjectReference: null, directnessBasis: null };
    expect(decodeReviewTransport(logical, raw).checks[1].unitChecks[0].contrasts[0].verdict).toBe("inconsistent");
    answer.scopeWitness.invalidMember = 99;
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.scopeWitness.invalidMember = 3; answer.verdict = "consistent";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.kind = "technical"; answer.reference = null; answer.verdict = "inconsistent";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("preflights full-length dense punctuation, reference and Unicode vectors without clipping", () => {
    const { inputs, selection } = fictionalInputs();
    const plan = selection.documents.flatMap(d => planManagedComparisons(managedClaimContext(inputs.draft.source, selection.draftClaimNos), selection.draftClaimNos,
      [{ candidateId: d.docId, source: managedClaimContext(inputs.documents.find(s => s.id === d.docId)!.source, d.claimNos) }]).chunks);
    const evidence = { claimNo: Number.MAX_SAFE_INTEGER, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER, quote: "\ud800".repeat(120) };
    const make = (pattern: string) => reviewInput(plan, plan.flatMap(c => c.pairs.map(p => {
      const text = (n: number) => pattern.repeat(n).slice(0, n);
      return { ...p, docId: c.candidateId, baseObservation: text(120), candidateObservation: text(120), common: text(200), differences: text(200), unconfirmed: text(120), baseEvidence: evidence, candidateEvidence: evidence };
    })));
    const size = (logical: ReturnType<typeof reviewInput>) => requestBytes(REVIEW_TRANSPORT_SYSTEM, JSON.stringify(reviewTransportInput(logical)), reviewTransportSchemaFor(logical));
    const max = make("\ud800"), upper = size(max) + max.targets.length * 32;
    expect(upper).toBeLessThanOrEqual(90000);
    for (const pattern of ["。\ud800", "。a", "、", "請求項一\ud800", "請求項1/2、", "𠮷。", "\ud842、\udc00"]) {
      const logical = make(pattern), input = reviewTransportInput(logical);
      expect(size(logical)).toBeLessThanOrEqual(upper);
      expect(input.targets.map(t => t.text)).toEqual(logical.targets.map(t => t.text));
      input.targets.forEach(target => expect(target.unitIds).toHaveLength(reviewTargetUnits(target.text).length));
      const ids = input.targets.flatMap(target => target.unitIds);
      expect(ids).toEqual(ids.map((_, i) => i));
    }
  });

  it("reserves four-digit global IDs for all1540 sentences mixed with maximal JSON escaping", () => {
    const { inputs, selection } = fictionalInputs();
    const body = "【請求項1】\n主装置は光を備える。\n【請求項2】\n請求項1に記載の装置であって、記録を保持する。";
    inputs.draft = parseComparisonSource(body, 11, "基準");
    inputs.documents = [21, 22].map(id => parseComparisonSource(body, id, `候補${id}`));
    selection.documents = inputs.documents.map(d => ({ docId: d.id, claimNos: [1, 2], identity: { publication: d.label, edition: "架空" } }));
    const plan = makePlan(inputs, selection);
    const drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({ ...p, baseObservation: "基準条件。", candidateObservation: "候補条件。" })));
    const make = (pattern: string) => reviewInput(plan, drafts.map(d => {
      const text = (n: number) => pattern.repeat(n).slice(0, n);
      return { ...d, baseObservation: text(120), candidateObservation: text(120), common: text(200), differences: text(200), unconfirmed: text(120) };
    }));
    const maximum = make("\ud800"), actual = make("。\ud800"), wire = reviewTransportInput(actual);
    const ids = wire.targets.flatMap(target => target.unitIds);
    expect(wire.targets).toHaveLength(20); expect(ids).toHaveLength(1540);
    expect(ids[999]).toBe(999); expect(ids[1000]).toBe(1000); expect(ids.at(-1)).toBe(1539);
    const size = (input: ReturnType<typeof reviewInput>) => requestBytes(REVIEW_TRANSPORT_SYSTEM, JSON.stringify(reviewTransportInput(input)), reviewTransportSchemaFor(input));
    const allowance = maximum.targets.reduce((sum, target) => sum + 32 + Math.floor(target.text.length / 4) * 2, 0);
    expect(size(actual)).toBeLessThanOrEqual(size(maximum) + allowance);
    expect(wire.targets.map(target => target.text)).toEqual(actual.targets.map(target => target.text));
  });
});
