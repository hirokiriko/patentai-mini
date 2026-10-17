import { describe, expect, it } from "vitest";
import { parseComparisonSource } from "./source";
import { answerSchema, comparisonPrompt, LIMITS, makePlan, savedDigest, validateAnswer, validateSaved } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalSaved } from "./fixtures.test-support";
import { comparisonBlocks, comparisonCsv } from "./report";

describe("original-text comparison", () => {
  it("keeps source and prompt tails beyond 2,000 and 15,000, including positive/negative conditions", () => {
    const { inputs, selection } = fictionalInputs();
    expect(inputs.draft.source.claims[0].text.length).toBeGreaterThan(15000);
    const plan = makePlan(inputs, selection);
    expect(plan).toHaveLength(2);
    expect(comparisonPrompt(plan[0])).toContain("超えると青色弁を閉じる");
    expect(comparisonPrompt(plan[1])).toContain("下回ると青色弁を開く");
    const saved = validateSaved(fictionalSaved());
    expect(saved.pairs.every(p => p.baseEvidence.start > 15000)).toBe(true);
    expect(saved.pairs[1].differences).toContain("低下・開動作");
  });
  it("tracks each exact source offset without normalizing Unicode", () => {
    const text = "【特許請求の範囲】\r\n【請求項１】\r\n  測定値𠮷とéを記録する装置。 \r\n【発明の詳細な説明】\n【図1】";
    const source = parseComparisonSource(text, 1, "fixture");
    const position = source.positions[0];
    expect(text.slice(position.start, position.end)).toBe(source.source.claims[0].text);
    expect(source.source.claims[0].text).toBe("測定値𠮷とéを記録する装置。");
  });
  it.each([
    null, "", "装置。", "【請求項1】\n" + "あ".repeat(1200),
    "【請求項2】\n装置。", "【請求項1】\n装置。\n【請求項3】\n装置。",
    "【請求項1】\n装置。\n【請求項1】\n装置。", "【請求項1】\n請求項2に記載の装置。",
    "【請求項1】\n請求項2に記載の装置。\n【請求項2】\n請求項1に記載の装置。",
    "【請求項1】\n【数1】を使用する装置。", "【請求項1】\n[image]を使用する装置。",
    "【請求項1】\n省略した装置。", "【請求項1】\n不正�な装置。",
  ])("rejects insufficient/ambiguous/unsupported original %s", text => {
    expect(() => parseComparisonSource(text, 1, "fixture")).toThrow("source_review_required");
  });
  it("keeps multiple/transitive references while targeting only selected pairs", () => {
    const { inputs, selection } = fictionalInputs();
    const source = parseComparisonSource("【請求項1】\n温度を測る装置。\n【請求項2】\n請求項1に記載の装置。\n【請求項3】\n請求項1及び2に記載の装置。", 11, "draft-11");
    inputs.draft = source; selection.draftClaimNos = [3];
    const plan = makePlan(inputs, selection);
    expect(plan[0].base.claims.map(c => c.claimNo)).toEqual([1,2,3]);
    expect(plan[0].pairs).toEqual([{ baseClaimNo: 3, candidateClaimNo: 1 }]);
  });
  it("rejects all-target plans that exceed the finite call budget before sending", () => {
    const { inputs, selection } = fictionalInputs();
    selection.draftClaimNos = [1,2]; selection.documents.forEach(d => { d.claimNos = [1,2]; });
    expect(() => makePlan(inputs, selection)).toThrow("plan_limit");
  });
  it("rejects changed inputs and other-case document IDs", () => {
    const { inputs, selection } = fictionalInputs();
    expect(() => makePlan(inputs, { ...selection, inputDigest: "b".repeat(64) })).toThrow("stale_input");
    selection.documents[0].docId = 999;
    expect(() => makePlan(inputs, selection)).toThrow("selection_invalid");
  });
  it.each(["missing", "duplicate", "wrong_pair", "wrong_quote", "ambiguous_quote", "wrong_claim", "legal_conclusion"])("rejects %s", kind => {
    const { inputs, selection } = fictionalInputs(); const chunk = makePlan(inputs, selection)[0];
    const answer = fictionalAnswer(chunk);
    if (kind === "missing") answer.results = [];
    if (kind === "duplicate") answer.results.push(answer.results[0]);
    if (kind === "wrong_pair") answer.results[0].candidateClaimNo = 2;
    if (kind === "wrong_quote") answer.results[0].baseEvidence.quote = "存在しない根拠";
    if (kind === "ambiguous_quote") answer.results[0].baseEvidence.quote = "各区域の測定値を保持する";
    if (kind === "wrong_claim") answer.results[0].baseEvidence.claimNo = 99;
    if (kind === "legal_conclusion") answer.results[0].common = "新規性がない";
    expect(() => validateAnswer(chunk, answer)).toThrow("ai_incomplete");
  });
  it("rereads JSON independent of key order and refuses changed source/position/version", () => {
    const saved = fictionalSaved();
    const reorder = (v: unknown): unknown => Array.isArray(v) ? v.map(reorder) : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).reverse().map(([k,x]) => [k,reorder(x)])) : v;
    expect(validateSaved(reorder(saved))).toEqual(saved);
    for (const edit of [(s: typeof saved) => { s.inputs.draft.source = { ...s.inputs.draft.source, claims: s.inputs.draft.source.claims.map(c => ({ ...c, text: c.text + "改変。" })) }; },
      (s: typeof saved) => s.pairs[0].baseEvidence.start++, (s: typeof saved) => s.selection.documents[0].identity.edition = "別版"]) {
      const changed = structuredClone(saved); edit(changed);
      expect(() => validateSaved(changed)).toThrow("result_invalid");
    }
  });
  it("does not promote legacy or unknown versions", () => {
    expect(() => validateSaved({ matched: [], explanation: "keyword fallback" })).toThrow("result_invalid");
    expect(() => validateSaved({ ...fictionalSaved(), version: 2 })).toThrow("result_invalid");
  });
  it("can read and export stored originals even when a later request prompt exceeds its input budget", () => {
    const saved = fictionalSaved();
    const [first, second] = saved.inputs.draft.source.claims;
    // A larger, previously saved original; existing quotes retain their offsets.
    saved.inputs.draft = parseComparisonSource(`【請求項1】\n${first.text}${"補".repeat(7800)}。\n【請求項2】\n${second.text}`, 11, "draft-11");
    saved.snapshotDigest = savedDigest(saved);
    expect(() => makePlan(saved.inputs, saved.selection)).toThrow("plan_limit");
    expect(validateSaved(saved)).toEqual(saved);
    expect(comparisonBlocks(saved, true).some(b => b.text === saved.inputs.draft.source.claims[0].text)).toBe(true);
    expect(comparisonCsv(saved, true)).toContain(saved.inputs.draft.source.claims[0].text);
    // A matching digest cannot excuse altered quotes or missing coverage.
    for (const change of [(s: typeof saved) => s.pairs[0].baseEvidence.start++, (s: typeof saved) => s.pairs.pop()]) {
      const invalid = structuredClone(saved); change(invalid); invalid.snapshotDigest = savedDigest(invalid);
      expect(() => validateSaved(invalid)).toThrow("result_invalid");
    }
  });
  it("bounds the largest permitted output below the token envelope without clipping sources", () => {
    const pair = { baseClaimNo: 1000, candidateClaimNo: 1000, common: "漢".repeat(200), differences: "漢".repeat(200),
      unconfirmed: "漢".repeat(120), baseEvidence: { claimNo: 1000, quote: "漢".repeat(120) }, candidateEvidence: { claimNo: 1000, quote: "漢".repeat(120) } };
    const answer = answerSchema.parse({ results: [pair, pair] });
    expect(Buffer.byteLength(JSON.stringify(answer), "utf8") + 2048).toBeLessThan(LIMITS.outputTokens);
  });
});
