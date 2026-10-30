import { describe, expect, it } from "vitest";
import { sourceReadingClaim } from "./source-clause-coverage";
import { sourceIdentifiedQuoteDictionary, resolveSourceOrderedQuote, sourceDeclaredOrderedEvidence } from "./source-reading-tasks";
import { decodeClaimQuotationQuotes } from "./source-claim-quotations";

type Decoded = { id: string; first: number; last: number; quote: string; before: string; after: string };
const q = (quote: string, before = "", after = "", id = "q17") => ({ id, quote, before, after });

describe("claim-local exact quotation decoding", () => {
  it("retains the complete raw quotation/context and derives a cross-clause range", () => {
    const c = sourceReadingClaim(1, "赤器から出た冷媒を、青弁を経て緑器に流す。");
    const raw = [Object.freeze(q("赤器から出た冷媒を、青弁を経て緑器に流す"))], saved = structuredClone(raw);
    expect(decodeClaimQuotationQuotes(c, raw)).toEqual([{ ...raw[0], first: 0, last: 1 }]);
    expect(raw).toEqual(saved);
  });

  it("rejects repeated quotations without explicit uniquely matching context", () => {
    const c = sourceReadingClaim(1, "甲赤弁乙丙赤弁丁。");
    expect(() => decodeClaimQuotationQuotes(c, [q("赤弁")])).toThrow();
    const raw = [q("赤弁", "甲", "", "q0"), q("赤弁", "", "丁", "q9999")];
    const decoded = decodeClaimQuotationQuotes(c, raw) as Decoded[];
    expect(decoded.map(({ id, ...locator }) => ({ id, span: resolveSourceOrderedQuote(c, locator, [0]) })))
      .toEqual([{ id: "q0", span: [1, 3] }, { id: "q9999", span: [5, 7] }]);
    expect(sourceIdentifiedQuoteDictionary(c, decoded).quotes).toHaveLength(2);
    expect(decoded.map(v => ({ id: v.id, quote: v.quote }))).toEqual(raw.map(({ id, quote }) => ({ id, quote })));
    expect(raw).toEqual([q("赤弁", "甲", "", "q0"), q("赤弁", "", "丁", "q9999")]);
  });

  it("preserves raw adjacent context but prevents it from inflating internal quote coverage", () => {
    const c = sourceReadingClaim(1, "甲、赤弁、乙。");
    const raw = [q("赤弁", "甲、", "、乙。")];
    const decoded = decodeClaimQuotationQuotes(c, raw) as Decoded[];
    expect(decoded).toEqual([{ id: raw[0].id, quote: raw[0].quote, before: "", after: "", first: 1, last: 1 }]);
    expect(raw).toEqual([q("赤弁", "甲、", "、乙。")]);
    const { id: _id, ...locator } = decoded[0];
    expect(_id).toBe(raw[0].id);
    // Only [2,4] is the selected quotation. Its surrounding context is not a
    // claim that the text of clauses 0 or 2 was quoted or semantically read.
    expect(resolveSourceOrderedQuote(c, locator, [1])).toEqual([2, 4]);
    expect(sourceDeclaredOrderedEvidence(c, { m: { u: [locator] },
      O: { selection: null, extent: null, polarity: null, guard: null, context: null }, F: null })).toEqual([1]);
  });

  it("keeps astral characters, combining marks and whitespace exactly as supplied", () => {
    const text = "😀赤弁é 😀赤弁é終。", c = sourceReadingClaim(1, text);
    const raw = [q("😀赤弁é", "", "終。")];
    const decoded = decodeClaimQuotationQuotes(c, raw) as Decoded[];
    expect(decoded[0].quote).toBe(raw[0].quote);
    expect(raw).toEqual([q("😀赤弁é", "", "終。")]);
    const { id: _id, ...locator } = decoded[0];
    expect(_id).toBe(raw[0].id);
    const start = text.lastIndexOf("😀赤弁é");
    expect(resolveSourceOrderedQuote(c, locator, [0])).toEqual([start, start + raw[0].quote.length]);
    expect(() => decodeClaimQuotationQuotes(c, [q("😀赤弁é", "", "終。")])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("😀赤弁é", " ", "終。")])).not.toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("😀赤弁é", "  ", "終。")])).toThrow();
  });

  it("rejects a quote or context boundary splitting an original surrogate pair", () => {
    const c = sourceReadingClaim(1, "😀赤弁。");
    expect(() => decodeClaimQuotationQuotes(c, [q("\ud83d", "", "\ude00")])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("\ude00", "\ud83d", "")])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("赤弁", "\ude00", "")])).toThrow();
  });

  it("does not search another claim, normalize text, repair ranges or alter wrong context", () => {
    const c = sourceReadingClaim(1, "甲赤弁乙。");
    for (const raw of [[q("青弁")], [q("赤弁", "丙")], [q("赤弁", "甲", "丙")],
      [q(" 赤弁 ")], [{ ...q("赤弁"), first: 0, last: 0 }]])
      expect(() => decodeClaimQuotationQuotes(c, raw)).toThrow();
  });

  it.each([null, {}, ["q0|0-0:赤器"], [{ id: "q0", K: [0, 0, 0, 1] }],
    [q("赤器", "", "", "q0a")], [q("赤器", "", "", "q10000")],
    [{ id: "q0", quote: "赤器", before: "" }], [q("")],
    [{ id: "q0", quote: "赤器", before: null, after: "" }]])("rejects malformed and old coordinate declarations %#", value => {
    expect(() => decodeClaimQuotationQuotes(sourceReadingClaim(1, "赤器。"), value)).toThrow();
  });

  it("rejects duplicate IDs and duplicate selected spans even with different context", () => {
    const c = sourceReadingClaim(1, "甲赤弁乙青弁丙。");
    expect(() => decodeClaimQuotationQuotes(c, [q("赤弁"), q("青弁")])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("赤弁", "甲", "", "q0"), q("赤弁", "", "乙", "q1")])).toThrow();
  });

  it("preserves the twelve-clause limit for the quotation and its supplied context", () => {
    const c = sourceReadingClaim(1, "赤、".repeat(13) + "終。");
    expect(() => decodeClaimQuotationQuotes(c, [q(c.grid.text)])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("終", "赤、".repeat(13))])).toThrow();
    const twelve = sourceReadingClaim(1, "赤、".repeat(11) + "終。");
    expect(() => decodeClaimQuotationQuotes(twelve, [q("終", "赤、".repeat(11))])).not.toThrow();
  });

  it("bounds declaration count, individual strings and total wire bytes", () => {
    const c = sourceReadingClaim(1, "赤".repeat(12001) + "。");
    expect(() => decodeClaimQuotationQuotes(c, Array.from({ length: 1025 }, (_, i) => q("赤", "", "", `q${i}`)))).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("赤".repeat(12001))])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, [q("。", "赤".repeat(12001))])).toThrow();
    expect(() => decodeClaimQuotationQuotes(c, Array.from({ length: 6 }, (_, i) => q("赤".repeat(12000), "", "", `q${i}`)))).toThrow();
  });
});
