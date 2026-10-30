import { describe, expect, it } from "vitest";
import { reviewReferenceMentions, validateReferenceRelations, type ReferenceRelationCheck } from "./reference-mentions";

describe("literal draft reference relations", () => {
  it.each(["請求項8-12", "請求項８／１２", "請求項八乃至請求項十二", "請求項8から12", "請求項12まで", "請求項8/9/12"])("keeps exact UTF16 offsets without inventing a connective in %s", quote => {
    const text = `𠮷。${quote}の装置。`, mentions = reviewReferenceMentions(text);
    expect(mentions).toEqual([{ start: 3, end: 3 + quote.length }]);
    expect(text.slice(mentions[0].start, mentions[0].end)).toBe(quote);
    expect(() => validateReferenceRelations(text, { start: 3, end: text.length }, [{ start: 3, relation: "unspecified", operatorBasis: null }], false)).not.toThrow();
  });
  it.each(["missing", "duplicate", "foreign", "all_without_basis", "any_without_basis", "range_as_basis", "foreign_basis", "wrong_word", "wrong_relation", "unresolved_as_c"])("refuses %s evidence before a semantic verdict can pass", mode => {
    const text = "前文。請求項8-12の装置。", unit = { start: 3, end: text.length };
    const checks: ReferenceRelationCheck[] = [{ start: 3, relation: "unspecified", operatorBasis: null }];
    if (mode === "missing") checks.pop();
    if (mode === "duplicate") checks.push({ ...checks[0] });
    if (mode === "foreign") checks[0].start = 4;
    if (mode === "all_without_basis") checks[0].relation = "all";
    if (mode === "any_without_basis") checks[0].relation = "any";
    if (mode === "range_as_basis") Object.assign(checks[0], { relation: "all", operatorBasis: { start: 3, quote: "請求項8-12" } });
    if (mode === "foreign_basis") Object.assign(checks[0], { relation: "all", operatorBasis: { start: 0, quote: "全て" } });
    if (mode === "wrong_word") Object.assign(checks[0], { relation: "all", operatorBasis: { start: text.indexOf("装置"), quote: "装置" } });
    if (mode === "wrong_relation") Object.assign(checks[0], { relation: "unspecified", operatorBasis: { start: 0, quote: "全て" } });
    if (mode === "unresolved_as_c") checks[0].relation = "unresolved";
    expect(() => validateReferenceRelations(text, unit, checks, false)).toThrow();
  });
  it.each([["全て", "all"], ["いずれか", "any"]] as const)("accepts an exact literal %s proof without claiming semantic attachment", (word, relation) => {
    const text = `請求項8-12の${word}を継承する。`;
    const checks = [{ start: 0, relation, operatorBasis: { start: text.indexOf(word), quote: word } }];
    expect(() => validateReferenceRelations(text, { start: 0, end: text.length }, checks, false)).not.toThrow();
    checks[0].operatorBasis.start++;
    expect(() => validateReferenceRelations(text, { start: 0, end: text.length }, checks, false)).toThrow();
  });
  it("only permits unresolved interpretation when the unit is uncertain", () => {
    const text = "請求項8-12の装置。";
    expect(() => validateReferenceRelations(text, { start: 0, end: text.length }, [{ start: 0, relation: "unresolved", operatorBasis: null }], true)).not.toThrow();
  });
});
