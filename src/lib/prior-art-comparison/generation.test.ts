import { describe, expect, it } from "vitest";
import { generationInput, generationSchema, generationSchemaFor, decodeGeneration } from "./generation";
import { LIMITS, makePlan, savedDigest, validateAnswer, validateSaved } from "./comparison";
import { fictionalGeneration, fictionalInputs, fictionalSaved } from "./fixtures.test-support";
import { parseComparisonSource } from "./source";

function example() {
  const { inputs, selection } = fictionalInputs();
  const chunk = makePlan(inputs, selection)[0];
  return { inputs, selection, chunk, answer: fictionalGeneration(generationInput(chunk)) };
}

describe("literal evidence selection", () => {
  it("partitions all source characters losslessly, including whitespace and surrogate boundaries", () => {
    const { inputs, selection } = fictionalInputs();
    inputs.draft = parseComparisonSource(`【請求項1】\n${"あ".repeat(119)}𠮷é\r\n${" ".repeat(121)}${"装置。".repeat(80)}末尾の否定条件。`, 11, "draft-11");
    const chunk = makePlan(inputs, selection)[0];
    const input = generationInput(chunk);
    for (const side of ["base", "candidate"] as const) {
      input[side].claims.forEach((claim, i) => {
        expect(claim.segments.map(s => s.text).join("")).toBe(chunk[side].claims[i].text);
        for (const s of claim.segments) {
          expect(s.text.length).toBeLessThanOrEqual(120);
          expect(s.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
        }
      });
    }
    expect(input.base.claims[0].segments.some(s => !s.quotable)).toBe(true);
  });
  it("restores exact long-source tail quotes and keeps saved v1 unchanged", () => {
    const { chunk, answer } = example();
    const pair = validateAnswer(chunk, decodeGeneration(chunk, answer))[0];
    expect(pair.baseEvidence.start).toBeGreaterThan(15000);
    expect(pair.candidateEvidence.start).toBeGreaterThan(2000);
    expect(pair.baseEvidence.quote).toContain("七度を超えると");
    expect(pair).not.toHaveProperty("baseObservation");
    expect(validateSaved(fictionalSaved()).version).toBe(1);
  });
  it.each(["unknown", "side", "document", "version", "ambiguous", "joined", "quote_injection"])("rejects %s evidence", mode => {
    const { chunk, answer } = example();
    const r = answer.results[0];
    if (mode === "unknown") r.baseEvidenceId = `b${"0".repeat(64)}:0:1:0`;
    if (mode === "side") r.baseEvidenceId = r.candidateEvidenceId;
    if (mode === "document") r.candidateEvidenceId = r.candidateEvidenceId.replace(":21:", ":22:");
    if (mode === "version") r.baseEvidenceId = `b${r.baseEvidenceId[1] === "f" ? "0" : "f"}${r.baseEvidenceId.slice(2)}`;
    if (mode === "ambiguous") r.baseEvidenceId = generationInput(chunk).base.claims[0].segments.find(s => !s.quotable)!.id;
    if (mode === "joined") r.baseEvidenceId += r.baseEvidenceId;
    if (mode === "quote_injection") Object.assign(r, { baseEvidence: { claimNo: 1, quote: "加工...引用" } });
    expect(() => validateAnswer(chunk, decodeGeneration(chunk, answer))).toThrow("ai_incomplete");
  });
  it("constrains provider output to the actual side-specific eligible IDs", () => {
    const { chunk, answer } = example();
    expect(generationSchemaFor(chunk).parse(answer)).toEqual(answer);
    answer.results[0].baseEvidenceId = answer.results[0].candidateEvidenceId;
    expect(generationSchemaFor(chunk).safeParse(answer).success).toBe(false);
  });
  it("rejects excessive provider enums before reservation even for compact source text", () => {
    const { inputs, selection, chunk } = example();
    const body = Array.from({ length: 252 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(56)};`).join("") + "。";
    inputs.draft = parseComparisonSource(`【請求項1】\n${body}`, 11, "draft-11");
    const projected = generationInput({ ...chunk, base: inputs.draft.source });
    expect(projected.base.claims[0].segments.filter(s => s.quotable).length).toBeGreaterThan(250);
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThan(60000);
    expect(() => makePlan(inputs, selection)).toThrow("plan_limit");
  });
  it("rejects another pair's claim but accepts the selected pair's transitive ancestor", () => {
    const { inputs, selection } = fictionalInputs();
    inputs.draft = parseComparisonSource("【請求項1】\n基準となる第一装置。\n【請求項2】\n独立した第二装置。\n【請求項3】\n請求項1に記載の第三装置。", 11, "draft-11");
    selection.draftClaimNos = [2, 3];
    const chunk = makePlan(inputs, selection)[0];
    const answer = fictionalGeneration(generationInput(chunk));
    expect(generationInput(chunk).pairs.map(p => [p.baseClaimNo, p.baseContextClaimNos])).toEqual([[2, [2]], [3, [1, 3]]]);
    const ancestorId = generationInput(chunk).base.claims.find(c => c.claimNo === 1)!.segments[0].id;
    answer.results.find(r => r.baseClaimNo === 3)!.baseEvidenceId = ancestorId;
    expect(validateAnswer(chunk, decodeGeneration(chunk, answer))).toHaveLength(2);
    answer.results.find(r => r.baseClaimNo === 2)!.baseEvidenceId = ancestorId;
    expect(() => validateAnswer(chunk, decodeGeneration(chunk, answer))).toThrow("ai_incomplete");
  });
  it("preflights unquotable scope without making old snapshots depend on segmentation", () => {
    const saved = fictionalSaved();
    // Every segment repeats, but the A→B boundary is unique in the original.
    const body = ["A", "B", "A", "C", "B", "C"].map(s => s.repeat(119) + "。").join("");
    saved.inputs.draft = parseComparisonSource(`【請求項1】\n${body}`, 11, "draft-11");
    saved.pairs.forEach(p => { p.baseEvidence = { claimNo: 1, quote: "A。B", start: 118, end: 121 }; });
    saved.snapshotDigest = savedDigest(saved);
    expect(() => makePlan(saved.inputs, saved.selection)).toThrow("source_review_required");
    expect(validateSaved(saved)).toEqual(saved);
  });
  it("does not mistake valid evidence IDs for a semantic quality assessment", () => {
    const { chunk, answer } = example();
    answer.results[0].common = "基準側の条件は七度を下回ると青色弁を開くことである。"; // Deliberately false.
    expect(validateAnswer(chunk, decodeGeneration(chunk, answer))).toHaveLength(1);
    // Meaning still requires independent original-text review; no automatic GO.
    expect(fictionalSaved().review).toBe("human_review_required");
  });
  it("allows an ordinary technical noun that also names an input collection", () => {
    const { chunk, answer } = example();
    answer.results[0].unconfirmed = "装置のsegments間の対応は未確認。";
    expect(validateAnswer(chunk, decodeGeneration(chunk, answer))).toHaveLength(1);
  });
  it.each(["baseObservation", "candidateObservation", "common", "differences", "unconfirmed"] as const)("rejects protocol metadata in new %s without invalidating old results", field => {
    const { chunk, answer } = example();
    answer.results[0][field] = "quotable=falseのため比較できません。";
    expect(() => decodeGeneration(chunk, answer)).toThrow("ai_incomplete");
    const saved = fictionalSaved();
    saved.pairs[0].unconfirmed = "非quotable区間のため未確認。";
    saved.snapshotDigest = savedDigest(saved);
    expect(validateSaved(saved)).toEqual(saved);
  });
  it("keeps the complete bounded wire output within the existing envelope", () => {
    const { answer } = example();
    const r = answer.results[0];
    r.baseEvidenceId = `b${"a".repeat(64)}:0:1000:9999999`;
    r.candidateEvidenceId = `c${"b".repeat(64)}:9007199254740991:1000:9999999`;
    r.baseObservation = r.candidateObservation = r.unconfirmed = "漢".repeat(120);
    r.common = r.differences = "漢".repeat(200);
    const parsed = generationSchema.parse({ results: [r, r] });
    expect(Buffer.byteLength(JSON.stringify(parsed)) + 2048).toBeLessThan(LIMITS.outputTokens);
  });
});
