import { describe, expect, it } from "vitest";
import { planManagedComparisons, validateManagedClaims, validateManagedComparisons, managedDigest,
  MANAGED_CHUNK_BYTES, type ManagedClaimSet } from "./managed-claims";

const base: ManagedClaimSet = { publicationNumber: "JP-FICTIONAL-BASE", version: "published-A1",
  claims: [{ claimNo: 1, text: "架空の検出装置。", dependsOn: [] }, { claimNo: 2, text: "請求項1に記載の検出装置であって架空の制御部を備える。", dependsOn: [1] }] };
const candidate: ManagedClaimSet = { publicationNumber: "JP-FICTIONAL-CANDIDATE", version: "published-A1",
  claims: [{ claimNo: 3, text: "架空の長い請求項".repeat(350) + "末尾固有の検出部", dependsOn: [] }] };
const plan = () => planManagedComparisons(base, [2], [{ candidateId: 8, source: candidate }]);
const result = () => ({ results: [{ baseClaimNo: 2, candidateClaimNo: 3,
  lexicalScore: 0.3, elementScore: 0.4, semanticScore: 0.5, structuralScore: 0.6, riskLabel: "Medium",
  baseEvidence: { claimNo: 1, start: 0, end: 8, quote: "架空の検出装置。" }, candidateEvidence: { claimNo: 3, start: candidate.claims[0].text.indexOf("末尾固有"), end: candidate.claims[0].text.length, quote: "末尾固有の検出部" },
  explanation: "末尾に対応する構成があり、原文の人手確認が必要です。" }] });
describe("bounded full claim planning", () => {
  it("freezes a value snapshot without retaining mutable caller references", () => {
    const input = structuredClone(candidate);
    const p = planManagedComparisons(base, [2], [{ candidateId: 8, source: input }]);
    const digest = p.digest;
    (input.claims[0] as { text: string }).text = "caller changed after preparation";
    expect(p.chunks[0].candidate.claims[0].text).toBe(candidate.claims[0].text);
    expect(managedDigest({ selectedClaimNos: p.selectedClaimNos, chunks: p.chunks })).toBe(digest);
    expect(Object.isFrozen(p.chunks[0].candidate.claims[0].dependsOn)).toBe(true);
  });
  it("rejects unrelated private properties before creating an AI payload", () => {
    expect(() => planManagedComparisons({ ...base, customerContact: "FICTIONAL-PRIVATE-SENTINEL" } as ManagedClaimSet, [1], [])).toThrow("claims_invalid");
    expect(() => planManagedComparisons({ ...base, claims: [{ ...base.claims[0], privateNote: "FICTIONAL-PRIVATE-SENTINEL" }] } as unknown as ManagedClaimSet, [1], [])).toThrow("claims_invalid");
  });
  it("keeps bytes after 2,000 characters and dependency context without promoting context to selected claims", () => {
    const p = plan();
    expect(p.selectedClaimNos).toEqual([2]);
    expect(p.chunks[0].base.claims).toEqual(base.claims);
    expect(p.chunks[0].candidate.claims).toEqual(candidate.claims);
    expect(p.chunks[0].pairs).toEqual([{ baseClaimNo: 2, candidateClaimNo: 3 }]);
    expect(p.chunks[0].candidate.claims[0].text.endsWith("末尾固有の検出部")).toBe(true);
    expect(validateManagedComparisons(p.chunks[0], result())).toHaveLength(1);
  });
  it("covers every selected claim and every candidate claim exactly once across chunks", () => {
    const source = { ...candidate, claims: Array.from({ length: 25 }, (_, i) => ({ claimNo: i + 1, text: "架空の公報請求項。".repeat(200), dependsOn: [] })) };
    const p = planManagedComparisons(base, [1, 2], [{ candidateId: 8, source }]);
    const pairs = p.chunks.flatMap(c => c.pairs.map(x => `${x.baseClaimNo}:${x.candidateClaimNo}`));
    expect(p.chunks.length).toBeGreaterThan(1);
    expect(pairs).toHaveLength(50); expect(new Set(pairs).size).toBe(50);
    expect(p.chunks.every(c => Buffer.byteLength(JSON.stringify(c)) <= MANAGED_CHUNK_BYTES)).toBe(true);
    expect(p.chunks.every(c => c.baseDigest === managedDigest(base) && c.candidateDigest === managedDigest(source))).toBe(true);
  });
  it("binds source version, selected set and full content to the plan", () => {
    const a = plan().digest;
    expect(planManagedComparisons({ ...base, version: "corrected" }, [2], [{ candidateId: 8, source: candidate }]).digest).not.toBe(a);
    expect(planManagedComparisons(base, [1], [{ candidateId: 8, source: candidate }]).digest).not.toBe(a);
    expect(planManagedComparisons(base, [2], [{ candidateId: 8, source: { ...candidate, claims: [{ ...candidate.claims[0], text: candidate.claims[0].text + "変更" }] } }]).digest).not.toBe(a);
  });
  it.each([
    { ...base, claims: [] },
    { ...base, claims: [base.claims[0], base.claims[0]] },
    { ...base, claims: [{ ...base.claims[0], dependsOn: [9] }] },
    { ...base, claims: [{ ...base.claims[0], dependsOn: [2] }, base.claims[1]] },
    { ...base, claims: [{ ...base.claims[0], text: "" }] },
  ])("rejects missing, duplicate, cyclic or blank claims", source => expect(() => validateManagedClaims(source)).toThrow());
  it("rejects an atomic claim plus reference context that cannot fit rather than truncating", () => {
    expect(() => planManagedComparisons(base, [2], [{ candidateId: 8, source: { ...candidate,
      claims: [{ ...candidate.claims[0], text: "架".repeat(40_000) }] } }])).toThrow("split_limit");
  });
  it("stops before dispatch when the entire coverage exceeds forty chunks", () => {
    const source = { ...candidate, claims: Array.from({ length: 250 }, (_, i) => ({ claimNo: i + 1, text: "架空の請求項。", dependsOn: [] })) };
    expect(() => planManagedComparisons(base, [1, 2], [{ candidateId: 8, source }])).toThrow("split_limit");
  });
  it("rejects nonexistent or duplicate selected claim numbers and document ids", () => {
    expect(() => planManagedComparisons(base, [9], [])).toThrow("reference_missing");
    expect(() => planManagedComparisons(base, [1, 1], [])).toThrow("claims_invalid");
    expect(() => planManagedComparisons(base, [1], [{ candidateId: 1, source: candidate }, { candidateId: 1, source: candidate }])).toThrow("coverage_invalid");
  });
  it("rejects omitted/duplicate/nonexistent output and evidence outside the actual text", () => {
    const chunk = plan().chunks[0];
    for (const invalid of [ { results: [] }, { results: [result().results[0], result().results[0]] },
      { results: [{ ...result().results[0], candidateClaimNo: 999 }] },
      { results: [{ ...result().results[0], baseClaimNo: 1 }] },
      { results: [{ ...result().results[0], candidateEvidence: { claimNo: 3, start: 1, end: 99999 } }] },
      { results: [{ ...result().results[0], candidateEvidence: { claimNo: 9, start: 0, end: 1 } }] },
      { results: [{ ...result().results[0], baseEvidence: { ...result().results[0].baseEvidence, quote: "原文にない補造" } }] },
    ]) expect(() => validateManagedComparisons(chunk, invalid)).toThrow("coverage_invalid");
  });
});
