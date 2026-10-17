import { describe, expect, it } from "vitest";
import { managedClaimReferences } from "../koho-import/managed-claim-source";
import type { ManagedClaim, ManagedClaimSet } from "../patent-watch/managed-claims";
import { buildReferenceLogicGuide } from "./reference-logic";

const claim = (claimNo: number, text = "架空の独立装置。", dependsOn = managedClaimReferences(text)): ManagedClaim => ({ claimNo, text, dependsOn });
const source = (...claims: ManagedClaim[]): ManagedClaimSet => ({ publicationNumber: "FICT-REFERENCE-LOGIC", version: "fictional-A1", claims });
const guide = (text: string, refs?: number[]) => buildReferenceLogicGuide(source(claim(1), claim(2), claim(3), claim(4, text, refs)), [4]);

describe("comparison-only reference logic", () => {
  it("distinguishes shared ancestors from every possible reference branch", () => {
    const input = source(claim(3), claim(4, "請求項3に記載の架空装置。"), claim(5, "請求項4に記載の架空装置。"),
      claim(6, "請求項4又は5に記載の架空装置。"), claim(7, "請求項6に記載の架空装置。"),
      claim(8, "請求項3に記載の架空装置。"), claim(9, "請求項8に記載の架空装置。"),
      claim(10, "請求項3乃至9の何れかに記載の架空装置。"), claim(11, "請求項3乃至10の何れかに記載の架空装置。"));
    const result = buildReferenceLogicGuide(input, [6, 10, 11]);
    expect(result.scopes.map(s => s.guaranteedClaimNos)).toEqual([[3, 4, 6], [3, 10], [3, 11]]);
    expect(result.scopes[2]).toMatchObject({ fullyResolved: true, closureClaimNos: [3, 4, 5, 6, 7, 8, 9, 10, 11],
      conditionalClaimNos: [4, 5, 6, 7, 8, 9, 10], unknownClaimNos: [] });
    expect(result.claims.find(c => c.claimNo === 11)).toMatchObject({ relation: "any_of", directRefs: [3, 4, 5, 6, 7, 8, 9, 10] });
  });

  it("retains independent roots of an OR and adds a single dependent claim", () => {
    const base = buildReferenceLogicGuide(source(claim(1), claim(2), claim(3, "請求項1又は2に記載。")), [3]);
    expect(base.scopes[0].guaranteedClaimNos).toEqual([3]);
    const candidate = buildReferenceLogicGuide(source(claim(1), claim(2, "請求項1に記載。"), claim(3),
      claim(4, "請求項3に記載。"), claim(5, "請求項4に記載。"), claim(6, "請求項1乃至5の何れかに記載。"),
      claim(7, "請求項6に記載。")), [6, 7]);
    expect(candidate.scopes.map(s => s.guaranteedClaimNos)).toEqual([[6], [6, 7]]);
    expect(candidate.scopes[1].closureClaimNos).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("unions the recursively inherited sets for an explicit AND", () => {
    const result = buildReferenceLogicGuide(source(claim(1), claim(2, "請求項1に記載。"), claim(3),
      claim(4, "請求項2及び請求項3に記載。")), [4]);
    expect(result.scopes[0]).toMatchObject({ guaranteedClaimNos: [1, 2, 3, 4], conditionalClaimNos: [], fullyResolved: true });
  });

  it.each([
    ["請求項1、2又は3に記載。", "any_of"],
    ["請求項1または請求項2に記載。", "any_of"],
    ["請求項1若しくは2に記載。", "any_of"],
    ["請求項1もしくは2に記載。", "any_of"],
    ["請求項1から3のいずれかに記載。", "any_of"],
    ["請求項1～3のうち何れか一項に記載。", "any_of"],
    ["請求項1～3の内いずれか一項に記載。", "any_of"],
    ["請求項1から3のいずれか1つの請求項に記載。", "any_of"],
    ["請求項1、および請求項2に記載。", "all_of"],
    ["請求項１，２，及び３に記載。", "all_of"],
    ["請求項1から3のすべてに記載。", "all_of"],
  ])("classifies only explicit operators in %s", (text, relation) => {
    const result = guide(text);
    expect(result.claims.at(-1)).toMatchObject({ relation, unresolvedReasons: [] });
    expect(result.scopes[0].fullyResolved).toBe(true);
    expect(result.claims.at(-1)?.referenceClauses).toHaveLength(1);
  });

  it("supports the explicit ALL synonym without modifying the shared parser or source", () => {
    const text = "請求項1から3の全てに記載。";
    expect(() => managedClaimReferences(text)).toThrow("reference_missing");
    expect(guide(text, [1, 2, 3]).claims.at(-1)?.relation).toBe("all_of");
    expect(guide(text, [1, 2, 3]).claims.at(-1)?.referenceClauses[0].text).toBe("請求項1から3の全て");
  });

  it.each([
    ["請求項1から3に記載。", [1, 2, 3]],
    ["請求項1、2、3に記載。", [1, 2, 3]],
    ["請求項1及び2のいずれかに記載。", [1, 2]],
    ["請求項1又は2のすべてに記載。", [1, 2]],
    ["請求項1及び2又は3に記載。", [1, 2, 3]],
    ["請求項1に記載の装置と請求項2に記載の部材。", [1, 2]],
    ["請求項1に記載の装置及び請求項2に記載の部材。", [1, 2]],
    ["請求項1及び／又は2に記載。", [1, 2]],
    ["請求項1並びに2に記載。", [1, 2]],
    ["前記請求項のいずれかに記載。", [1, 2]],
  ] as const)("does not invent a relation for %s", (text, refs) => {
    const result = guide(text, [...refs]);
    expect(result.claims.at(-1)?.relation).toBe("unresolved");
    expect(result.scopes[0]).toMatchObject({ fullyResolved: false, guaranteedClaimNos: null, conditionalClaimNos: null });
    expect(result.scopes[0].unknownClaimNos).toEqual(result.scopes[0].closureClaimNos);
  });

  it("propagates unknown ancestry rather than declaring a single reference resolved", () => {
    const result = buildReferenceLogicGuide(source(claim(1), claim(2), claim(3, "請求項1、2に記載。"), claim(4, "請求項3に記載。")), [4]);
    expect(result.claims.at(-1)?.relation).toBe("single");
    expect(result.scopes[0]).toMatchObject({ fullyResolved: false, guaranteedClaimNos: null, conditionalClaimNos: null, unknownClaimNos: [1, 2, 3, 4] });
  });

  it.each([
    ["請求項1、2のいずれか2項に記載。", [1, 2]],
    ["請求項1、2、3のいずれか2項に記載。", [1, 2, 3]],
    ["請求項１、２、３のいずれか２項に記載。", [1, 2, 3]],
    ["請求項1、2、3のいずれか二項に記載。", [1, 2, 3]],
    ["請求項1、2、3のいずれか1項以上に記載。", [1, 2, 3]],
    ["請求項1、2、3のいずれか一項以下に記載。", [1, 2, 3]],
    ["請求項1、2、3のいずれか一つずつに記載。", [1, 2, 3]],
    ["請求項1から3の少なくともいずれか一項に記載。", [1, 2, 3]],
    ["少なくとも請求項1、2のいずれか一項に記載。", [1, 2]],
    ["少なくとも前記請求項1、2のいずれか一項に記載。", [1, 2]],
  ] as const)("does not drop a selector quantity or modifier: %s", (text, refs) => {
    const input = source(claim(1), claim(2), claim(3), claim(4, text, [...refs]), claim(5, "請求項4に記載。"));
    const result = buildReferenceLogicGuide(input, [4, 5]);
    expect(result.claims.find(c => c.claimNo === 4)).toMatchObject({ relation: "unresolved", unresolvedReasons: ["reference_invalid"] });
    expect(result.scopes.every(s => !s.fullyResolved && s.guaranteedClaimNos === null && s.conditionalClaimNos === null)).toBe(true);
  });

  it.each([
    "請求項1に記載の装置及び2に記載の装置。",
    "請求項1に記載の装置又は２に記載の装置。",
    "請求項1に記載の装置と2に係る部材。",
    "請求項1に記載の装置、2の記載の装置。",
    "請求項1に記載の装置及び2記載の装置。",
    "請求項1に記載の装置及び第2項記載の装置。",
    "請求項1に記載の装置及び2において検出する装置。",
  ])("does not resolve a partial prefix followed by an omitted reference: %s", text => {
    expect(managedClaimReferences(text)).toEqual([1]);
    expect(guide(text).claims.at(-1)).toMatchObject({ relation: "unresolved", unresolvedReasons: ["reference_invalid"] });
    expect(guide(text).scopes[0].guaranteedClaimNos).toBeNull();
  });

  it("keeps metadata mismatch unresolved even when the metadata graph is valid", () => {
    const result = guide("請求項1又は2に記載。", [1, 3]);
    expect(result.claims.at(-1)).toMatchObject({ relation: "unresolved", unresolvedReasons: ["references_mismatch"] });
    expect(result.scopes[0].fullyResolved).toBe(false);
  });

  it("uses UTF-16 exact spans and ignores operators outside the reference phrase", () => {
    const text = "🧪架空のA又はB及びCを備える。\n　請求項１，２のいずれかに記載の装置は、全ての検出値を処理する。";
    const result = guide(text), item = result.claims.at(-1)!;
    expect(item.relation).toBe("any_of");
    expect(item.referenceClauses).toEqual([{ text: "請求項１，２のいずれか", start: text.indexOf("請求項"), end: text.indexOf("に記載"), refs: [1, 2] }]);
    for (const span of item.referenceClauses) expect(text.slice(span.start, span.end)).toBe(span.text);
    expect(guide("請求項1に記載の装置はA又はB及びCを備える。").claims.at(-1)?.relation).toBe("single");
    expect(guide("請求項1に記載の装置及び2つの架空部材を備える。").claims.at(-1)?.relation).toBe("single");
    expect(guide("架空のA又はB及びCを備え全てを検出する。", []).claims.at(-1)?.relation).toBe("none");
  });

  it("retains each exact phrase when separate reference clauses are unresolved", () => {
    const text = "請求項1に記載の架空装置と、請求項2に記載の架空部材。";
    const clauses = guide(text).claims.at(-1)!.referenceClauses;
    expect(clauses.map(c => c.text)).toEqual(["請求項1", "請求項2"]);
    for (const c of clauses) expect(text.slice(c.start, c.end)).toBe(c.text);
  });

  it("preserves full source text and dependencies without duplicating text in the guide", () => {
    const input = source(claim(1, "架空原文。".repeat(4000) + "末尾条件。"), claim(2, "請求項1に記載の架空装置。"));
    const before = JSON.stringify(input), result = buildReferenceLogicGuide(input, [2]);
    expect(JSON.stringify(input)).toBe(before);
    expect(input.claims[0].text.endsWith("末尾条件。")).toBe(true);
    expect(result.claims.map(c => c.claimNo)).toEqual([1, 2]);
    expect(result.claims.every(c => !("text" in c))).toBe(true);
    expect(Object.isFrozen(result.scopes[0].guaranteedClaimNos)).toBe(true);
    expect(Object.isFrozen(result.claims[1].referenceClauses[0])).toBe(true);
  });

  it("handles a long chain iteratively and excludes unrelated claims", () => {
    const input = source(...Array.from({ length: 300 }, (_, i) => claim(i + 1, i ? `請求項${i}に記載。` : undefined)), claim(900));
    const result = buildReferenceLogicGuide(input, [300]);
    expect(result.scopes[0].guaranteedClaimNos).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    expect(result.claims).toHaveLength(300);
  });

  it("rejects missing references, cycles, invalid selections, and malformed source shape", () => {
    expect(() => buildReferenceLogicGuide(source(claim(2, "請求項1に記載。")), [2])).toThrow("reference_missing");
    expect(() => buildReferenceLogicGuide(source(claim(1, "請求項2に記載。"), claim(2, "請求項1に記載。")), [2])).toThrow("reference_missing");
    expect(() => buildReferenceLogicGuide(source(claim(1)), [9])).toThrow("reference_missing");
    for (const selected of [[], [1, 1], [0], [1.5]]) expect(() => buildReferenceLogicGuide(source(claim(1)), selected)).toThrow("claims_invalid");
    expect(() => buildReferenceLogicGuide({ ...source(claim(1)), privateNote: "FICT-EXTRA-FIELD" } as ManagedClaimSet, [1])).toThrow("claims_invalid");
  });
});
