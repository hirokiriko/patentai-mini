import { describe, expect, it } from "vitest";
import { sourceReadingClaim } from "./source-clause-coverage";
import { sourceCellRef, resolveSourceCellRef } from "./source-citation-grid";
import { sourceIdentifiedQuoteDictionary, resolveSourceOrderedQuote } from "./source-reading-tasks";
import { decodeClaimCoordinateQuotes } from "./source-claim-coordinates";

describe("claim coordinate quote decoding", () => {
  const c = sourceReadingClaim(1, "赤器から出た冷媒を、青弁を経て緑器に流す。" );
  const quote = (text: string, id = "q9") => {
    const at = c.grid.text.indexOf(text);
    return { id, K: sourceCellRef(c.grid, [at, at + text.length]) };
  };
  it("derives cross-clause ranges from the selected span without regenerating text", () => {
    const input = [quote("赤器から出た冷媒を、青弁を経て緑器に流す")], saved = structuredClone(input);
    expect(decodeClaimCoordinateQuotes(c, input)).toEqual([{ id: "q9", first: 0, last: 1,
      quote: "赤器から出た冷媒を、青弁を経て緑器に流す", before: "", after: "" }]);
    expect(input).toEqual(saved);
  });
  it("retains the exact selected repeated occurrence using minimal adjacent context", () => {
    const repeated = sourceReadingClaim(1, "甲赤弁乙丙赤弁丁。");
    const input = [2, 6].map((end, i) => ({ id: `q${i}`, K: sourceCellRef(repeated.grid, [end - 1, end + 1]) }));
    const decoded = decodeClaimCoordinateQuotes(repeated, input) as { id: string; first: number; last: number; quote: string; before: string; after: string }[];
    expect(decoded.map(q => q.quote)).toEqual(["赤弁", "赤弁"]);
    expect(decoded.map(q => Array.from(q.before + q.after).length)).toEqual([1, 1]);
    decoded.forEach(({ id: _id, ...q }, i) => {
      expect(_id).toBe(`q${i}`);
      expect(resolveSourceOrderedQuote(repeated, q, [0])).toEqual(resolveSourceCellRef(repeated.grid, input[i].K));
    });
    expect(sourceIdentifiedQuoteDictionary(repeated, decoded).quotes).toHaveLength(2);
  });
  it("keeps astral scalars, combining marks and whitespace exact", () => {
    const unicode = sourceReadingClaim(1, "😀赤弁é 😀赤弁é終。");
    const at = unicode.grid.text.lastIndexOf("赤弁é"), input = [{ id: "q9999", K: sourceCellRef(unicode.grid, [at, at + 4]) }];
    const decoded = decodeClaimCoordinateQuotes(unicode, input) as { quote: string; before: string; after: string }[];
    expect(decoded[0].quote).toBe(unicode.grid.text.slice(at, at + 4));
    expect(JSON.stringify(decoded)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef])/i);
  });
  it.each([null, {}, ["q0|0-0:赤器"], [{ id: "q0a", K: [0, 0, 0, 1] }],
    [{ id: "q10000", K: [0, 0, 0, 1] }], [{ id: "q0", K: [] }],
    [{ id: "q0", K: [0, 0, 0, 10] }], [{ id: "q0", K: [0, 2, 0, 1] }],
    [{ id: "q0", K: [999, 0, 999, 1] }], [{ id: "q0", K: [0, 0.5, 0, 1] }],
    [{ id: "q0", K: [0, 0, 0, 1], quote: "赤器" }]])("rejects malformed or old free-text declarations %#", value => {
    expect(() => decodeClaimCoordinateQuotes(c, value)).toThrow();
  });
  it("rejects duplicate IDs and duplicate spans", () => {
    expect(() => decodeClaimCoordinateQuotes(c, [quote("赤器"), quote("青弁")])).toThrow();
    expect(() => decodeClaimCoordinateQuotes(c, [quote("赤器"), quote("赤器", "q10")])).toThrow();
  });
  it("preserves the twelve-clause ceiling", () => {
    const long = sourceReadingClaim(1, "赤、".repeat(13));
    expect(() => decodeClaimCoordinateQuotes(long, [{ id: "q0", K: sourceCellRef(long.grid, [0, long.grid.text.length]) }])).toThrow();
  });
  it("bounds repeated-scalar context work without quadratic prefix copying", () => {
    const repeated = sourceReadingClaim(1, "赤".repeat(12000) + "。");
    const input = Array.from({ length: 128 }, (_, i) => ({ id: `q${i}`,
      K: sourceCellRef(repeated.grid, [i + 1, i + 2]) }));
    const started = performance.now();
    const decoded = decodeClaimCoordinateQuotes(repeated, input) as { id: string; first: number; last: number; quote: string; before: string; after: string }[];
    const elapsed = performance.now() - started;
    expect(decoded).toHaveLength(128);
    decoded.forEach(({ id, ...q }, i) => {
      expect(id).toBe(`q${i}`);
      expect(resolveSourceOrderedQuote(repeated, q, [0])).toEqual([i + 1, i + 2]);
      expect(q.quote).toBe("赤");
      expect(q.before).toBe("");
      expect(q.after.length).toBe(12000 - (i + 1));
    });
    // A generous regression ceiling; it is not a whole-request latency claim.
    expect(elapsed).toBeLessThan(5000);
    console.info(`coordinate repetition benchmark: ${elapsed.toFixed(1)}ms, 12001 scalars, 128 quotes`);
  });

});
