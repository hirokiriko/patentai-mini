import { describe, expect, it } from "vitest";
import { planManagedComparisons, resolveManagedComparisonQuotes, validateManagedComparisons } from "./managed-claims";

const fixture = (text = "前置き😀" + "架空の説明。".repeat(400) + "唯一の検出部。") => {
  const base = { publicationNumber: "JP-FICTIONAL-BASE", version: "A1", claims: [
    { claimNo: 1, text: "架空の参照装置。", dependsOn: [] },
    { claimNo: 2, text: "請求項1に記載の制御装置。", dependsOn: [1] },
    { claimNo: 3, text: "無関係の構成。", dependsOn: [] },
  ] };
  const candidate = { publicationNumber: "JP-FICTIONAL-CANDIDATE", version: "A1", claims: [{ claimNo: 4, text, dependsOn: [] }] };
  const chunk = planManagedComparisons(base, [2], [{ candidateId: 8, source: candidate }]).chunks[0];
  const value = { results: [{ baseClaimNo: 2, candidateClaimNo: 4, lexicalScore: 0.2, elementScore: 0.3, semanticScore: 0.4,
    structuralScore: 0.5, riskLabel: "Medium", explanation: "架空の対応構成。原文確認が必要です。",
    baseEvidence: { claimNo: 1, quote: "参照装置" }, candidateEvidence: { claimNo: 4, quote: "唯一の検出部" } }] };
  return { chunk, value, text };
};

describe("server-resolved exact evidence positions", () => {
  it("derives UTF-16 positions after 2,000 characters and resolves permitted reference claims", () => {
    const f = fixture(), before = structuredClone(f.value);
    const saved = resolveManagedComparisonQuotes(f.chunk, f.value);
    expect(saved.results[0].candidateEvidence).toEqual({ claimNo: 4, quote: "唯一の検出部", start: f.text.indexOf("唯一"), end: f.text.length - 1 });
    expect(saved.results[0].candidateEvidence.start).toBeGreaterThan(2_000);
    expect(saved.results[0].baseEvidence).toEqual({ claimNo: 1, quote: "参照装置", start: 3, end: 7 });
    expect(validateManagedComparisons(f.chunk, saved)).toEqual(saved.results);
    expect(f.value).toEqual(before);
  });
  it.each(["唯一の検出部・唯一の検出部", "全く別の原文。", "唯一の 検出部", "唯一の検出部\n唯一の検出部"])(
    "rejects absent or ambiguous quotes without normalization: %s", text => {
      const f = fixture(text);
      expect(() => resolveManagedComparisonQuotes(f.chunk, f.value)).toThrow("coverage_invalid");
    },
  );
  it("rejects overlapping occurrences, unrelated claims, blank evidence and model-supplied positions", () => {
    const overlap = fixture("あああ"); overlap.value.results[0].candidateEvidence.quote = "ああ";
    expect(() => resolveManagedComparisonQuotes(overlap.chunk, overlap.value)).toThrow("coverage_invalid");
    const f = fixture();
    for (const evidence of [{ claimNo: 3, quote: "無関係の構成" }, { claimNo: 1, quote: " " },
      { claimNo: 1, quote: "参照装置", start: 999, end: 1000 }]) {
      expect(() => resolveManagedComparisonQuotes(f.chunk, { results: [{ ...f.value.results[0], baseEvidence: evidence }] })).toThrow("coverage_invalid");
    }
  });
  it("preserves exact pair coverage and rejects surrogate fragments", () => {
    const f = fixture("架空😀の構成"); f.value.results[0].candidateEvidence.quote = "😀";
    expect(resolveManagedComparisonQuotes(f.chunk, f.value).results[0].candidateEvidence).toMatchObject({ start: 2, end: 4 });
    for (const results of [[], [f.value.results[0], f.value.results[0]], [{ ...f.value.results[0], baseClaimNo: 1 }]]) {
      expect(() => resolveManagedComparisonQuotes(f.chunk, { results })).toThrow("coverage_invalid");
    }
    f.value.results[0].candidateEvidence.quote = "\ud83d";
    expect(() => resolveManagedComparisonQuotes(f.chunk, f.value)).toThrow("coverage_invalid");
  });
});
