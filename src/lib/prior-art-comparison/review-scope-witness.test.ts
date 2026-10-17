import { describe, expect, it } from "vitest";
import { managedClaimContext, planManagedComparisons } from "../patent-watch/managed-claims";
import { parseComparisonSource } from "./source";
import { reviewInput, reviewTargetUnits } from "./semantic-review";
import { reviewScopeWitnessSchema, validateReviewScopeWitness } from "./review-scope-witness";

function example(text: string, field = "candidateObservation", choice = false) {
  const body = `【請求項1】\n架空の装置。\n【請求項2】\n請求項1に記載の装置であって、記録を保持する。\n【請求項3】\n${choice ? "請求項1又は2" : "請求項2"}に記載の装置であって、表示を備える。\n【請求項4】\n別の独立した架空装置。`;
  const base = managedClaimContext(parseComparisonSource(body, 11, "base").source, [3]);
  const candidate = managedClaimContext(parseComparisonSource(body, 21, "candidate").source, [3]);
  const plan = planManagedComparisons(base, [3], [{ candidateId: 21, source: candidate }]).chunks.flatMap(chunk => {
    const pairs = chunk.pairs.filter(pair => pair.candidateClaimNo === 3);
    return pairs.length ? [{ ...chunk, pairs }] : [];
  });
  const drafts = plan.flatMap(c => c.pairs.map(pair => ({ ...pair, docId: c.candidateId,
    baseObservation: "基準の記録。", candidateObservation: "候補の記録。", common: "共通の記録。", differences: "異なる記録。", unconfirmed: "未確認の記録。",
    baseEvidence: { claimNo: 3, start: 0, end: 1, quote: "請" }, candidateEvidence: { claimNo: 3, start: 0, end: 1, quote: "請" }, [field]: text,
  })));
  const input = reviewInput(plan, drafts), target = input.targets.find(t => t.id === `21:3:3:${field}`)!;
  const unit = reviewTargetUnits(target.text).at(-1)!;
  return { input, target, unit };
}
const ancestor = { scopeId: "candidate:21:3", invalidMember: 4, mode: "ancestor", subjectReference: null, directnessBasis: null };
const direct = { ...ancestor, invalidMember: 1, mode: "direct", directnessBasis: { word: "直接", occurrence: 1 } };
function check(text: string, witness: unknown = ancestor, ordinal = 1, field = "candidateObservation", choice = false) {
  const e = example(text, field, choice);
  validateReviewScopeWitness(e.input, e.target.id, e.unit, ordinal, witness);
}

describe("literal selected-scope rejection witnesses", () => {
  it.each(["請求項4", "請求項４", "請求項四", "請求項1-4", "請求項１～４", "請求項一乃至四", "請求項1/4", "請求項１／４", "請求項1・4", "請求項1、請求項4", "請求項4まで", "請求項一から四まで"])("accepts a real outside member in %s", reference => {
    expect(() => check(`候補側は${reference}の装置を継承する。`)).not.toThrow();
  });
  it("checks intervals without expanding a potentially huge range", () => {
    expect(() => check("候補側は請求項1-9007199254740991の装置を継承する。", { ...ancestor, invalidMember: 9007199254740991 })).not.toThrow();
  });
  it("accepts an intermediate member of a literal range", () => {
    expect(() => check("候補側は請求項1-5の装置を継承する。", { ...ancestor, invalidMember: 4 })).not.toThrow();
  });
  it.each(["請求項1-3", "請求項1/2", "請求項3まで"])("cannot prove ALL from an in-scope %s", reference => {
    expect(() => check(`候補側は${reference}の装置を継承する。`, { ...ancestor, invalidMember: 2 })).toThrow("ai_incomplete");
  });
  it("does not use guaranteed-only claims to reject a conditional ancestor", () => {
    expect(() => check("候補側は請求項2の装置を継承する。", { ...ancestor, invalidMember: 2 }, 1, "candidateObservation", true)).toThrow("ai_incomplete");
  });
  it("requires the invalid member in that exact mention, without an implicit range lower bound", () => {
    expect(() => check("候補側は請求項5までの装置を継承する。", { ...ancestor, invalidMember: 4 })).toThrow("ai_incomplete");
    expect(() => check("候補側は請求項4と請求項5の装置を継承する。", { ...ancestor, invalidMember: 5 }, 1)).toThrow("ai_incomplete");
  });
  it.each(["請求項四-一", "請求項1-3-4", "請求項十百", "請求項一二", "請求項一万", "請求項1.5", "請求項9007199254740992"])("stops an unsafe or ambiguous spelling %s", reference => {
    expect(() => check(`候補側は${reference}の装置を継承する。`)).toThrow("ai_incomplete");
  });
  it("accepts conventional Kanji units", () => {
    expect(() => check("候補側は請求項二十三の装置を継承する。", { ...ancestor, invalidMember: 23 })).not.toThrow();
  });
  it("retains the selected subject instead of a caller-supplied source claim", () => {
    expect(() => check("候補側は請求項4の装置を継承する。", { ...ancestor, sourceClaimNo: 1 })).toThrow("ai_incomplete");
    expect(reviewScopeWitnessSchema.safeParse({ ...ancestor, extra: true }).success).toBe(false);
  });
  it("binds observation fields and explicit side words to the matching source", () => {
    expect(() => check("候補側は請求項4の装置を継承する。", { ...ancestor, scopeId: "base:3" })).toThrow("ai_incomplete");
    expect(() => check("基準側は請求項4の装置を継承する。", ancestor)).toThrow("ai_incomplete");
    expect(() => check("基準側は請求項4の装置を継承する。", { ...ancestor, scopeId: "base:3" }, 1, "common")).not.toThrow();
    expect(() => check("基準側は請求項4の装置を継承する。", ancestor, 1, "common")).toThrow("ai_incomplete");
    expect(() => check("請求項4の装置を継承する。", ancestor, 1, "common")).toThrow("ai_incomplete");
  });
  it("accepts an explicit selected subject followed by a bad ancestor", () => {
    expect(() => check("候補側の請求項3は請求項4を継承する。", { ...ancestor, subjectReference: 1 }, 2)).not.toThrow();
  });
  it("keeps the selected subject for every object of the same affirmative predicate", () => {
    expect(() => check("候補側の請求項3は請求項2と請求項4を継承する。", { ...ancestor, subjectReference: 1 }, 3)).not.toThrow();
    expect(() => check("候補側は請求項2と請求項4を継承する。", ancestor, 2)).not.toThrow();
    expect(() => check("候補側の請求項3は請求項2と請求項4に直接従属する。", { ...direct, invalidMember: 4, subjectReference: 1 }, 3)).not.toThrow();
    expect(() => check("候補側の請求項2は請求項1と請求項4を継承する。", { ...ancestor, subjectReference: 1 }, 3)).toThrow("ai_incomplete");
    expect(() => check("候補側の請求項3は請求項2を継承し、請求項4は記録を保持する。", { ...ancestor, subjectReference: 1 }, 3)).toThrow("ai_incomplete");
  });
  it.each([null, 1])("does not rebind another subject with subjectReference=%s", subjectReference => {
    expect(() => check("候補側の請求項2は請求項4を継承する。", { ...ancestor, subjectReference }, 2)).toThrow("ai_incomplete");
  });
  it("does not turn a parent object into the selected subject", () => {
    expect(() => check("候補側は請求項3に従属する請求項4の装置。", { ...ancestor, subjectReference: 1 }, 2)).toThrow("ai_incomplete");
  });
  it.each([
    "候補側は請求項4を継承しない。", "候補側は請求項4を引用しない。",
    "候補側は請求項4を継承するとは限らない。", "候補側は請求項4を継承する可能性がある。",
    "候補側は請求項4を継承し得る。", "候補側は請求項4を継承する、という仮定を置く。",
    "候補側は「請求項4を継承する」と述べる。", "「候補側は請求項4を継承する。」",
    "候補側は請求項4の装置。",
  ])("does not treat an unsupported, negative or quoted relation as proof: %s", text => {
    expect(() => check(text)).toThrow("ai_incomplete");
  });
  it("requires an explicit directness basis before rejecting an indirect ancestor", () => {
    expect(() => check("候補側は請求項1に直接従属する。", direct)).not.toThrow();
    expect(() => check("候補側は請求項1を継承する。", { ...direct, directnessBasis: null })).toThrow("ai_incomplete");
    expect(() => check("候補側は請求項1に直接従属する。", { ...direct, mode: "ancestor" })).toThrow("ai_incomplete");
    expect(() => check("候補側は請求項2に直接従属する。", { ...direct, invalidMember: 2 })).toThrow("ai_incomplete");
  });
  it("binds directness to the selected subject and exact word occurrence", () => {
    const text = "直接という語を使う候補側の請求項3は請求項1に直接従属する。";
    expect(() => check(text, { ...direct, subjectReference: 1, directnessBasis: { word: "直接", occurrence: 2 } }, 2)).not.toThrow();
    expect(() => check(text, { ...direct, subjectReference: 1 }, 2)).toThrow("ai_incomplete");
    expect(() => check("候補側の請求項3は請求項1と請求項2へ直接従属する。", { ...direct, subjectReference: 1 }, 2)).toThrow("ai_incomplete");
  });
  it.each([
    "候補側は請求項1に直接従属しない。", "候補側は請求項1に直接従属するとは限らない。",
    "候補側は請求項1の制御器へ直接接続する。", "候補側は請求項1の制御器に直接従属する。",
    "候補側は請求項1の構成を継承し、冷媒を直接加熱する。",
    "候補側は請求項1を引用し、直接加熱する。", "候補側は「直接」という語で請求項1に従属する。",
    "候補側は直接という語を用いて請求項1に従属する。",
  ])("does not borrow a negative, quoted or technical directly: %s", text => {
    expect(() => check(text, direct)).toThrow("ai_incomplete");
  });
  it("retains a real inheritance assertion despite a later technical directly", () => {
    expect(() => check("候補側は請求項4の構成を継承し、冷媒を直接加熱する。", ancestor)).not.toThrow();
    expect(() => check("候補側は直接請求項1に従属する。", direct)).not.toThrow();
  });
  it("uses unit-local ordinals without counting or rewriting Unicode text", () => {
    const text = "𠮷。候補側は請求項四の装置を継承する。", e = example(text), before = JSON.stringify(e.input);
    expect(e.unit.start).toBe(3);
    expect(() => validateReviewScopeWitness(e.input, e.target.id, e.unit, 1, ancestor)).not.toThrow();
    expect(JSON.stringify(e.input)).toBe(before);
    expect(() => validateReviewScopeWitness(e.input, e.target.id, { ...e.unit, text: "請求項四。" }, 1, ancestor)).toThrow("ai_incomplete");
  });
  it("refuses foreign scopes, missing references and invalid witness numbers", () => {
    for (const witness of [{ ...ancestor, scopeId: "candidate:22:3" }, { ...ancestor, invalidMember: 0 }, { ...ancestor, invalidMember: 1.5 }, { ...ancestor, subjectReference: 0 }]) {
      expect(() => check("候補側は請求項4の装置を継承する。", witness)).toThrow("ai_incomplete");
    }
    expect(() => check("候補側は請求項4の装置を継承する。", ancestor, 2)).toThrow("ai_incomplete");
  });
});
