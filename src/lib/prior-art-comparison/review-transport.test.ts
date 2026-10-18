import { describe, expect, it } from "vitest";
import { makePlan, validateAnswer } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalReview, fictionalTransportReview } from "./fixtures.test-support";
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
  const checks = logical.targets.flatMap(target => {
    const [doc, base, candidate, field] = target.id.split(":");
    const ids = [...(field === "candidateObservation" ? [] : [logical.base.claims.find(c => c.claimNo === Number(base))!.segments[0][0]]),
      ...(field === "baseObservation" ? [] : [logical.documents.find(d => d.docId === Number(doc))!.source.claims.find(c => c.claimNo === Number(candidate))!.segments[0][0]])];
    return reviewTargetUnits(target.text).map(unit => ({ unitId: unitId++,
      sourceReading: "架空原文の条件。意味品質の実証ではない。", assertion: "fact" as "fact" | "reservation" | "mixed",
      counterEvidence: null as null | { targetQuote: string; sourceWitness: { evidenceId: number; quote: string; occurrence: number }[] },
      referenceChecks: reviewReferenceMentions(target.text).filter(m => m.start >= unit.start && m.end <= unit.end)
        .map(() => ({ relation: "unspecified" as "unspecified" | "all" | "any" | "unresolved", operatorBasis: null as { quote: "全て" | "又は"; occurrence: number } | null })),
      kind: "technical" as "technical" | "reference_scope" | "reference_combination", reference: null as number | null,
      evidenceIds: ids, sourceComparison: "架空原文との対応。意味品質の実証ではない。",
      verdict: "consistent" as "consistent" | "inconsistent" | "uncertain",
      scopeWitness: null as { scopeId: string; invalidMember: number; mode: "ancestor" | "direct"; subjectReference: number | null; directnessBasis: { word: "直接"; occurrence: number } | null } | null }));
  });
  return { draftDigest: reviewTransportInput(logical).draftDigest, referenceChecks: checks.flatMap(row => row.referenceChecks),
    checks: checks.map(({ referenceChecks, ...row }) => { void referenceChecks; return row; }) };
}

/** Deliberately fictional negative certificate: tests literal provenance only,
 * never use it as an assertion that the target is actually contradicted. */
function negative(logical: ReturnType<typeof reviewInput>, answer: ReturnType<typeof response>["checks"][number]) {
  const unit = logical.targets.flatMap(t => reviewTargetUnits(t.text))[answer.unitId];
  const id = answer.evidenceIds[0], source = [logical.base, ...logical.documents.map(d => d.source)]
    .flatMap(s => s.claims).flatMap(c => c.segments).find(([key]) => key === id)!;
  answer.verdict = "inconsistent";
  answer.counterEvidence = { targetQuote: unit.text, sourceWitness: [{ evidenceId: id,
    quote: source[1].includes("記録を保持する。") ? "記録を保持する。" : source[1], occurrence: 1 }] };
}

const wireText = (unit: ReturnType<typeof reviewTransportInput>["units"][number]) => typeof unit === "string" ? unit : unit.join("");
// Reconstruct field context from the transmitted partition, independently of
// the original text used below as the lossless round-trip oracle.
const fieldRows = (input: ReturnType<typeof reviewTransportInput>) => input.fields.map(([id, firstUnitId, endUnitId]) =>
  ({ id, firstUnitId, units: input.units.slice(firstUnitId, endUnitId) }));
const wireIds = (target: ReturnType<typeof fieldRows>[number]) => target.units.map((_, index) => target.firstUnitId + index);

describe("whole-unit review transport", () => {
  it("keeps every source, scope, pair and field unchanged while numbering all units once", () => {
    const { logical } = example(), input = reviewTransportInput(logical);
    expect(input.task).toBe("review"); expect(input.draftDigest).not.toBe(logical.draftDigest);
    const wireSources = [input.base, ...input.documents.map(d => d.source)];
    const logicalSources = [logical.base, ...logical.documents.map(d => d.source)];
    wireSources.forEach((source, i) => {
      const original = logicalSources[i];
      expect(source.publicationNumber).toBe(original.publicationNumber); expect(source.version).toBe(original.version);
      expect(source.referenceLogic.relations).toEqual(original.referenceLogic.relations);
      expect(source.referenceLogic.scopes).toEqual(original.referenceLogic.scopes.map(scope => [scope.claimNo,
        [...scope.guaranteedClaimNos, ...scope.conditionalClaimNos].sort((a, b) => a - b)]));
      source.claims.forEach(([claimNo, dependsOn, segments], at) => {
        expect(claimNo).toBe(original.claims[at].claimNo); expect(dependsOn).toEqual(original.claims[at].dependsOn);
        expect(segments).toEqual(original.claims[at].segments);
        const text = segments.map(([, part]) => part).join("");
        expect(text).toBe(original.claims[at].segments.map(([, part]) => part).join(""));
        let start = 0;
        expect(segments.map(([id, part]) => { const entry = [id, text.slice(start, start + part.length)]; start += part.length; return entry; }))
          .toEqual(original.claims[at].segments);
        expect(start).toBe(text.length);
      });
    });
    expect(input.scopes.map(([id, side, docId, selectedClaimNo, contextClaimNos]) => ({ id, side, docId, selectedClaimNo, contextClaimNos }))).toEqual(logical.scopes);
    expect(input.pairs.map(([docId, baseClaimNo, candidateClaimNo, baseContextClaimNos, candidateContextClaimNos, b, c]) => ({
      docId, baseClaimNo, candidateClaimNo, baseContextClaimNos, candidateContextClaimNos,
      baseEvidence: { claimNo: b[0], start: b[1], end: b[2] }, candidateEvidence: { claimNo: c[0], start: c[1], end: c[2] } }))).toEqual(logical.pairs);
    expect(input.fields.at(-1)![2]).toBe(input.units.length);
    expect(input.fields.map(([id]) => id)).toEqual(logical.targets.map(t => t.id));
    const ids = fieldRows(input).flatMap(wireIds);
    expect(ids).toEqual(ids.map((_, i) => i));
    fieldRows(input).forEach((target, i) => {
      expect(target.units.map(wireText)).toEqual(reviewTargetUnits(logical.targets[i].text).map(unit => unit.text));
      expect(target.units.map(wireText).join("")).toBe(logical.targets[i].text);
      expect(input.fields[i]).toEqual([logical.targets[i].id, i ? input.fields[i - 1][2] : 0,
        (i ? input.fields[i - 1][2] : 0) + reviewTargetUnits(logical.targets[i].text).length]);
      expect(target).not.toHaveProperty("unitStarts"); expect(target).not.toHaveProperty("contrastCuts");
    });
    const raw = response(logical), before = JSON.stringify(raw), decoded = decodeReviewTransport(logical, raw);
    expect(decoded.draftDigest).toBe(logical.draftDigest);
    expect(inspectReviewCoverage(logical, decoded).checks).toHaveLength(logical.targets.length);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("exposes exact reference slots without duplicated text, normalized literals or interpreted relations", () => {
    const { plan, drafts } = example();
    drafts[0].baseObservation = "𠮷の装置。請求項１／二までの構成。請求項１／二までと請求項2を備える。";
    drafts[0].candidateObservation = "請求項2の装置。請求項２";
    const logical = reviewInput(plan, drafts), input = reviewTransportInput(logical);
    expect(fieldRows(input)[0]).toEqual({ id: logical.targets[0].id, firstUnitId: 0, units: [
      "𠮷の装置。", ["", "請求項１／二まで", "の構成。"], ["", "請求項１／二まで", "と", "請求項2", "を備える。"],
    ] });
    expect(fieldRows(input)[1]).toEqual({ id: logical.targets[1].id, firstUnitId: 3, units: [
      ["", "請求項2", "の装置。"], ["", "請求項２", ""],
    ] });
    fieldRows(input).forEach((target, index) => {
      expect(target.units.map(wireText).join("")).toBe(logical.targets[index].text);
      target.units.forEach(unit => {
        const text = wireText(unit), slots = typeof unit === "string" ? [] : unit.filter((_, index) => index % 2 === 1);
        expect(slots).toEqual(reviewReferenceMentions(text).map(m => text.slice(m.start, m.end)));
        if (Array.isArray(unit)) expect(unit.length % 2).toBe(1);
        if (!slots.length) expect(typeof unit).toBe("string");
      });
    });
    const decoded = decodeReviewTransport(logical, fictionalTransportReview(input));
    expect(decoded.checks[0].unitChecks.map(unit => unit.referenceChecks.length)).toEqual([0, 1, 2]);
    expect(decoded.checks[1].unitChecks.map(unit => unit.referenceChecks.length)).toEqual([1, 1]);
  });

  it("preserves the decisive long-source tail, Unicode boundaries and original evidence IDs", () => {
    const { inputs, selection } = fictionalInputs();
    const original = inputs.draft.source.claims[0].text;
    inputs.draft = parseComparisonSource(`【請求項1】\n${original.replace("末尾条件", "𠮷😀e\u0301の末尾条件")}\n【請求項2】\n請求項1に記載の装置であって、確認値を翌朝に消去する装置。`, 11, "draft-11");
    selection.draftClaimNos = [2];
    const plan = makePlan(inputs, selection), drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(pair => ({ ...pair,
      baseObservation: "基準の確認値を翌朝に消去する。", candidateObservation: "候補の末尾条件を保持する。" })));
    const logical = reviewInput(plan, drafts), source = reviewTransportInput(logical).base;
    const claim = source.claims.find(c => c[0] === 1)!, text = claim[2].map(([, part]) => part).join("");
    expect(text.length).toBeGreaterThan(15000);
    expect(text).toContain("𠮷😀e\u0301の末尾条件は温度が七度を超えると青色弁を閉じる");
    let start = 0;
    const reconstructed = claim[2].map(([id, part]) => {
      const segment = [id, text.slice(start, start + part.length)]; start += part.length; return segment;
    });
    expect(reconstructed).toEqual(logical.base.claims.find(c => c.claimNo === 1)!.segments);
    expect(start).toBe(text.length);
    expect(source.referenceLogic.relations).toEqual(logical.base.referenceLogic.relations);
    expect(source.referenceLogic.scopes.find(s => s[0] === 2)?.[1]).toEqual([1, 2]);
    expect(logical.base.referenceLogic.scopes.find(s => s.claimNo === 2)).toHaveProperty("guaranteedClaimNos");
  });

  it("does not reinterpret a unit number as evidence when it points to the wrong source", () => {
    const { inputs, selection } = fictionalInputs(), plan = makePlan(inputs, selection);
    const drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(pair => ({ ...pair,
      baseObservation: "基準の末尾条件。", candidateObservation: "候補の末尾条件。" })));
    const logical = reviewInput(plan, drafts), input = reviewTransportInput(logical), raw = response(logical);
    const candidateUnit = input.fields[1][1];
    expect(input.fields[1][0]).toContain("candidateObservation");
    expect(input.base.claims.flatMap(c => c[2]).some(([id]) => id === candidateUnit)).toBe(true);
    raw.checks[candidateUnit].evidenceIds = [candidateUnit];
    const before = JSON.stringify(raw), decoded = decodeReviewTransport(logical, raw);
    expect(() => inspectReviewCoverage(logical, decoded)).toThrow("ai_incomplete");
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("covers more than200 total references without adding a global cap or accepting legacy per-row references", () => {
    const { plan, drafts } = example();
    const text = "請求項1と請求項2を備える。".repeat(18);
    for (const draft of drafts) { draft.baseObservation = text; draft.candidateObservation = text; }
    const logical = reviewInput(plan, drafts), input = reviewTransportInput(logical), raw = response(logical);
    expect(input.referenceCount).toBe(216);
    expect(raw.referenceChecks).toHaveLength(input.referenceCount);
    const decoded = decodeReviewTransport(logical, raw);
    expect(decoded.checks.flatMap(c => c.unitChecks).flatMap(u => u.referenceChecks)).toHaveLength(216);
    expect(() => decodeReviewTransport(logical, { ...raw, referenceChecks: raw.referenceChecks.slice(0, -1) })).toThrow("ai_incomplete");
    expect(() => decodeReviewTransport(logical, { ...raw, referenceChecks: [...raw.referenceChecks, raw.referenceChecks[0]] })).toThrow("ai_incomplete");
    Object.assign(raw.checks[0], { referenceChecks: [] });
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
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
    const ids = wireIds(fieldRows(reviewTransportInput(logical))[3]);
    for (const id of ids) negative(logical, raw.checks[id]);
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
    const logical = reviewInput(plan, drafts), raw = response(logical), id = fieldRows(reviewTransportInput(logical))[3].firstUnitId;
    negative(logical, raw.checks[id]);
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
    raw.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
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
    raw.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
    if (mode === "missing") raw.referenceChecks.pop();
    if (mode === "extra") raw.referenceChecks.push({ ...raw.referenceChecks[0] });
    if (mode === "zero") raw.referenceChecks[0].operatorBasis!.occurrence = 0;
    if (mode === "fraction") raw.referenceChecks[0].operatorBasis!.occurrence = 1.5;
    if (mode === "unsafe") raw.referenceChecks[0].operatorBasis!.occurrence = Number.MAX_SAFE_INTEGER + 1;
    if (mode === "nonexistent") raw.referenceChecks[0].operatorBasis!.occurrence = 3;
    if (mode === "wrong_relation") raw.referenceChecks[0].relation = "any";
    if (mode === "basis_for_unspecified") raw.referenceChecks[0].relation = "unspecified";
    if (mode === "technical_reference") first.reference = 1;
    if (mode === "null_reference") first.kind = "reference_scope";
    if (mode === "foreign_reference") { first.kind = "reference_scope"; first.reference = 2; }
    if (mode === "unresolved_c") raw.referenceChecks[0] = { relation: "unresolved", operatorBasis: null };
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("counts basis occurrences inside this unit only", () => {
    const { logical, raw } = referenceExample("全ての弁を備える。請求項1-2の全てを備える。");
    raw.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 2 } };
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    raw.referenceChecks[0].operatorBasis!.occurrence = 1;
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[1].referenceChecks[0].operatorBasis?.start)
      .toBe(logical.targets[0].text.lastIndexOf("全て"));
  });

  it("binds multiple references in their exact Unicode source order", () => {
    const { logical, raw } = referenceExample("𠮷の装置は、請求項１の全て、又は請求項２の装置を備える。");
    raw.referenceChecks[0] = { relation: "all", operatorBasis: { quote: "全て", occurrence: 1 } };
    raw.referenceChecks[1] = { relation: "any", operatorBasis: { quote: "又は", occurrence: 1 } };
    const checks = decodeReviewTransport(logical, raw).checks[0].unitChecks[0].referenceChecks;
    expect(checks.map(c => c.start)).toEqual(reviewReferenceMentions(logical.targets[0].text).map(m => m.start));
    expect(checks.map(c => c.operatorBasis?.start)).toEqual([logical.targets[0].text.indexOf("全て"), logical.targets[0].text.indexOf("又は")]);
  });

  it.each(["consistent", "inconsistent", "uncertain"] as const)("does not promote an unspecified combination to %s", verdict => {
    const { logical, raw, first } = referenceExample("請求項1-2の装置は、温度上限で停止する。");
    first.kind = "reference_combination"; first.reference = 1; first.verdict = verdict;
    if (verdict === "inconsistent") negative(logical, first);
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    first.kind = "technical"; first.reference = null;
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[0].contrasts[0].verdict).toBe(verdict);
  });

  it("requires a validated numeric scope witness only for a scope I", () => {
    const { plan, drafts } = example(2); drafts[0].candidateObservation = "候補側は請求項3の装置を継承する。";
    const logical = reviewInput(plan, drafts), raw = response(logical), id = fieldRows(reviewTransportInput(logical))[1].firstUnitId, answer = raw.checks[id];
    answer.kind = "reference_scope"; answer.reference = 1; answer.verdict = "inconsistent";
    negative(logical, answer);
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

  it.each(["missing", "blank_source", "target_absent", "target_repeated", "witness_absent", "wrong_side", "wrong_start", "wrong_occurrence", "empty_witness", "duplicate_witness", "control", "counter_for_c", "counter_for_u"])("refuses %s counter evidence without repairing the verdict", mode => {
    const { plan, drafts } = example(); drafts[0].baseObservation = "光を備える。光光を備える。";
    const logical = reviewInput(plan, drafts), raw = response(logical), answer = raw.checks[mode === "target_repeated" ? 1 : 0];
    negative(logical, answer);
    const counter = answer.counterEvidence!;
    if (mode === "missing") answer.counterEvidence = null;
    if (mode === "blank_source") answer.sourceReading = "　 ";
    if (mode === "target_absent") counter.targetQuote = "温度上限を超える";
    if (mode === "target_repeated") counter.targetQuote = "光";
    if (mode === "witness_absent") counter.sourceWitness[0].quote = "原文に存在しない結論";
    if (mode === "wrong_side") counter.sourceWitness[0].evidenceId = logical.documents[0].source.claims[0].segments[0][0];
    if (mode === "wrong_start") counter.sourceWitness[0].evidenceId = 99999;
    if (mode === "wrong_occurrence") counter.sourceWitness[0].occurrence = 2;
    if (mode === "empty_witness") counter.sourceWitness = [];
    if (mode === "duplicate_witness") counter.sourceWitness.push({ ...counter.sourceWitness[0] });
    if (mode === "control") counter.sourceWitness[0].quote += "\n";
    if (mode === "counter_for_c") answer.verdict = "consistent";
    if (mode === "counter_for_u") answer.verdict = "uncertain";
    const original = JSON.stringify(raw);
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    expect(JSON.stringify(raw)).toBe(original);
  });

  it("requires all touched source segments without adding missing evidence or imposing a120-character witness limit", () => {
    const { inputs, selection } = fictionalInputs();
    const text = "甲".repeat(118) + "𠮷の部材を備え、温度上限を超えた場合は弁を閉じる。末尾条件を保持する。";
    const body = `【請求項1】\n${text}`;
    inputs.draft = parseComparisonSource(body, 11, "draft");
    inputs.documents = [21, 22, 23].map(id => parseComparisonSource(body, id, "candidate"));
    const plan = makePlan(inputs, selection), drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({ ...p,
      baseObservation: "𠮷の部材は弁を開く。", candidateObservation: "候補の部材。" })));
    const logical = reviewInput(plan, drafts), raw = response(logical), answer = raw.checks[0];
    negative(logical, answer);
    const segments = logical.base.claims[0].segments;
    expect(segments.length).toBeGreaterThan(1);
    answer.evidenceIds = segments.map(([id]) => id);
    answer.counterEvidence!.sourceWitness = [{ evidenceId: segments[0][0], quote: text, occurrence: 1 }];
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[0].contrasts[0].verdict).toBe("inconsistent");
    answer.evidenceIds.pop();
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.evidenceIds = segments.map(([id]) => id);
    answer.counterEvidence!.sourceWitness[0].evidenceId = segments[1][0];
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.counterEvidence!.sourceWitness[0].evidenceId = segments[0][0];
    answer.counterEvidence!.sourceWitness[0].quote = "\ud842";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.counterEvidence!.sourceWitness[0].quote = text;
    answer.counterEvidence!.targetQuote = "\ud842";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("binds repeated source quotes to the requested occurrence without changing their text", () => {
    const { inputs, selection } = fictionalInputs(), body = "【請求項1】\n同条件で弁を閉じる。同条件で弁を閉じる。温度の記録を保持する。";
    inputs.draft = parseComparisonSource(body, 11, "draft");
    inputs.documents = [21, 22].map(id => parseComparisonSource(body, id, "candidate"));
    const plan = makePlan(inputs, selection), drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({ ...p,
      baseObservation: "弁を開く。", candidateObservation: "弁を開く。" })));
    const logical = reviewInput(plan, drafts), raw = response(logical), answer = raw.checks[0];
    negative(logical, answer);
    answer.counterEvidence!.sourceWitness[0].quote = "同条件で弁を閉じる。";
    answer.counterEvidence!.sourceWitness[0].occurrence = 2;
    expect(decodeReviewTransport(logical, raw).checks[0].unitChecks[0].contrasts[0].verdict).toBe("inconsistent");
    answer.counterEvidence!.sourceWitness[0].occurrence = 3;
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it.each(["document", "closure"])("rejects a counter witness from another %s even when its ID is included", mode => {
    const { inputs, selection } = fictionalInputs(), body = "【請求項1】\n光を備える。\n【請求項2】\n請求項1に記載の装置であって、記録を保持する。";
    inputs.draft = parseComparisonSource(body, 11, "draft");
    inputs.documents = [21, 22].map(id => parseComparisonSource(body, id, "candidate"));
    selection.documents.forEach(d => { d.claimNos = [1, 2]; });
    const plan = makePlan(inputs, selection), drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({ ...p,
      baseObservation: "光を備える。", candidateObservation: "光を備える。" })));
    const logical = reviewInput(plan, drafts), raw = response(logical), answer = raw.checks[1];
    negative(logical, answer);
    const other = logical.documents[mode === "document" ? 1 : 0].source.claims.find(c => c.claimNo === (mode === "document" ? 1 : 2))!.segments[0];
    answer.evidenceIds.push(other[0]);
    answer.counterEvidence!.sourceWitness = [{ evidenceId: other[0], quote: other[1], occurrence: 1 }];
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
  });

  it("does not let a source reference clause alone certify a technical rejection", () => {
    const { logical } = example(2), raw = response(logical), answer = raw.checks[2];
    negative(logical, answer);
    const clause = logical.documents[0].source.referenceLogic.relations[0].referenceClauses[0];
    answer.counterEvidence!.sourceWitness[0].quote = clause.text;
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    answer.counterEvidence!.sourceWitness[0].quote = clause.text + "に記載の装置";
    expect(() => decodeReviewTransport(logical, raw)).toThrow("ai_incomplete");
    // A literal technical quote can pass provenance even if its meaning is
    // wrong. Independent semantic QA remains required; no I is promoted to C.
    negative(logical, answer); answer.assertion = "reservation";
    expect(decodeReviewTransport(logical, raw).checks[1].unitChecks[0].contrasts[0].verdict).toBe("inconsistent");
  });

  it("preflights full-length dense punctuation, reference and Unicode vectors without clipping", () => {
    const { inputs, selection } = fictionalInputs();
    const plan = selection.documents.flatMap(d => planManagedComparisons(managedClaimContext(inputs.draft.source, selection.draftClaimNos), selection.draftClaimNos,
      [{ candidateId: d.docId, source: managedClaimContext(inputs.documents.find(s => s.id === d.docId)!.source, d.claimNos) }]).chunks);
    const evidence = { claimNo: Number.MAX_SAFE_INTEGER, start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER, quote: "\ud800".repeat(120) };
    const makeWith = (text: (n: number) => string) => reviewInput(plan, plan.flatMap(c => c.pairs.map(p => {
      return { ...p, docId: c.candidateId, baseObservation: text(120), candidateObservation: text(120), common: text(200), differences: text(200), unconfirmed: text(120), baseEvidence: evidence, candidateEvidence: evidence };
    })));
    const make = (pattern: string) => makeWith(n => pattern.repeat(n).slice(0, n));
    const size = (logical: ReturnType<typeof reviewInput>) => requestBytes(REVIEW_TRANSPORT_SYSTEM, JSON.stringify(reviewTransportInput(logical)), reviewTransportSchemaFor(logical));
    const max = make("\ud800"), upper = size(max) + max.targets.reduce((sum, target) => sum + 32 + Math.floor(target.text.length / 4) * 2, 0);
    expect(upper).toBeLessThanOrEqual(90000);
    for (const pattern of ["。\ud800", "。a", "、", "請求項一\ud800", "請求項1/2、", "𠮷。", "\ud842、\udc00"]) {
      const logical = make(pattern), input = reviewTransportInput(logical);
      expect(size(logical)).toBeLessThanOrEqual(upper);
      expect(fieldRows(input).map(t => t.units.map(wireText).join(""))).toEqual(logical.targets.map(t => t.text));
      fieldRows(input).forEach((target, i) => expect(target.units).toHaveLength(reviewTargetUnits(logical.targets[i].text).length));
      const ids = fieldRows(input).flatMap(wireIds);
      expect(ids).toEqual(ids.map((_, i) => i));
    }
    for (const fullWidth of [false, true]) {
      let nextReference = 0;
      const logical = makeWith(n => {
        let text = "";
        while (text.length < n) {
          const number = String(nextReference++);
          text += `請求項${fullWidth ? number.replace(/[0-9]/g, digit => String.fromCharCode(0xff10 + Number(digit))) : number}。`;
        }
        return text.slice(0, n);
      });
      const input = reviewTransportInput(logical);
      // A dictionary would duplicate every distinct full-width reference and
      // exceed the preflight envelope despite a repeated-reference test passing.
      expect(size(logical)).toBeLessThanOrEqual(upper);
      expect(input).not.toHaveProperty("refs");
      fieldRows(input).forEach((target, i) => {
        expect(target.units.map(wireText).join("")).toBe(logical.targets[i].text);
        target.units.forEach(unit => {
          if (typeof unit === "string") return;
          const text = unit.join("");
          expect(unit.length % 2).toBe(1);
          expect(unit.filter((_, part) => part % 2 === 1)).toEqual(reviewReferenceMentions(text).map(m => text.slice(m.start, m.end)));
        });
      });
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
    const ids = fieldRows(wire).flatMap(wireIds);
    expect(fieldRows(wire)).toHaveLength(20); expect(ids).toHaveLength(1540);
    expect(ids[999]).toBe(999); expect(ids[1000]).toBe(1000); expect(ids.at(-1)).toBe(1539);
    const size = (input: ReturnType<typeof reviewInput>) => requestBytes(REVIEW_TRANSPORT_SYSTEM, JSON.stringify(reviewTransportInput(input)), reviewTransportSchemaFor(input));
    const allowance = maximum.targets.reduce((sum, target) => sum + 32 + Math.floor(target.text.length / 4) * 2, 0);
    expect(size(actual)).toBeLessThanOrEqual(size(maximum) + allowance);
    expect(fieldRows(wire).map(target => target.units.map(wireText).join(""))).toEqual(actual.targets.map(target => target.text));
  });
});
