import { describe, expect, it } from "vitest";
import { managedClaimContext, type ManagedComparisonChunk } from "../patent-watch/managed-claims";
import { makePlan, SYSTEM } from "./comparison";
import { fictionalInputs } from "./fixtures.test-support";
import { batchInput, batchSchemaFor, generationBatches, requestBytes } from "./generation-batch";
import { LIMITS } from "./limits";
import { parseComparisonSource } from "./source";

function compact(first = [2, 3], second = [2, 3]) {
  const f = fictionalInputs();
  const text = "【請求項1】\n温度を記録する主装置。\n【請求項2】\n請求項1に記載の装置であって、末尾条件は赤色信号を保持する。\n【請求項3】\n請求項1に記載の装置であって、末尾条件は青色信号を消去する。\n【請求項4】\n請求項1に記載の装置であって、末尾条件は緑色信号を送信する。";
  f.inputs.draft = parseComparisonSource("【請求項1】\n温度を記録する基準装置。", 11, "基準");
  f.inputs.documents = [21, 22].map(id => parseComparisonSource(text, id, `架空${id}`));
  f.selection.documents = f.inputs.documents.map((d, i) => ({ docId: d.id, claimNos: i ? second : first,
    identity: { publication: d.label, edition: "架空" } }));
  return { ...f, plan: makePlan(f.inputs, f.selection) };
}
const count = (b: ManagedComparisonChunk[]) => b.reduce((n, c) => n + c.pairs.length, 0);
function prefix(plan: ManagedComparisonChunk[], n: number) {
  const selected: ManagedComparisonChunk[] = [];
  for (const c of plan) {
    const pairs = c.pairs.slice(0, n); n -= pairs.length;
    if (pairs.length) selected.push({ ...c, pairs,
      base: managedClaimContext(c.base, pairs.map(p => p.baseClaimNo)),
      candidate: managedClaimContext(c.candidate, pairs.map(p => p.candidateClaimNo)) });
  }
  return selected;
}
const bytes = (b: ManagedComparisonChunk[], system = "") => requestBytes(system, JSON.stringify(batchInput(b)), batchSchemaFor(b));

describe("complete-source generation packing", () => {
  it("packs two documents with two pairs each without changing their original text, ancestors or identities", () => {
    const { plan } = compact(), batches = generationBatches(plan, SYSTEM);
    expect(batches.map(count)).toEqual([4]); expect(batches[0].map(c => c.pairs.length)).toEqual([2, 2]);
    expect(batches[0].flatMap(c => c.pairs.map(p => [c.candidateId, p.baseClaimNo, p.candidateClaimNo])))
      .toEqual(plan.flatMap(c => c.pairs.map(p => [c.candidateId, p.baseClaimNo, p.candidateClaimNo])));
    for (const d of batchInput(batches[0]).documents) {
      const original = plan.find(c => c.candidateId === d.candidateId)!.candidate;
      expect(d.candidate.version).toBe(original.version);
      expect(d.candidate.claims.map(c => c.claimNo)).toEqual([1, 2, 3]);
      for (const c of d.candidate.claims) expect(c.segments.map(s => s.text).join(""))
        .toBe(original.claims.find(o => o.claimNo === c.claimNo)!.text);
    }
    expect(bytes(batches[0], SYSTEM)).toBeLessThanOrEqual(LIMITS.inputBytes);
  });
  it("preserves the two-pair document decoder for three-plus-one and four same-document pairs", () => {
    const f = compact([1, 2, 3], [1]);
    expect(generationBatches(f.plan, SYSTEM).map(count)).toEqual([2, 2]);
    const last = { ...f.plan[1], pairs: [{ baseClaimNo: 1, candidateClaimNo: 4 }],
      candidate: managedClaimContext(f.inputs.documents[0].source, [4]) };
    expect(generationBatches([...f.plan.slice(0, 2), last], SYSTEM).map(count)).toEqual([2, 2]);
  });
  it.each([3, 2])("falls back from four to %i complete pairs at the actual framed byte boundary", n => {
    const { plan } = compact(), first = prefix(plan, n), padding = "x".repeat(LIMITS.inputBytes - bytes(first));
    expect(bytes(first, padding)).toBe(LIMITS.inputBytes);
    expect(bytes(prefix(plan, n + 1), padding)).toBeGreaterThan(LIMITS.inputBytes);
    const batches = generationBatches(plan, padding);
    expect(batches.map(count)).toEqual(n === 3 ? [3, 1] : [2, 2]);
    for (const batch of batches) expect(bytes(batch, padding)).toBeLessThanOrEqual(LIMITS.inputBytes);
  });
  it("falls back from two to single pairs without omitting either document", () => {
    const { plan } = compact([2], [2]), padding = "x".repeat(LIMITS.inputBytes - bytes(prefix(plan, 1)));
    expect(bytes(plan, padding)).toBeGreaterThan(LIMITS.inputBytes);
    expect(generationBatches(plan, padding).map(count)).toEqual([1, 1]);
  });
  it("retains the long-source two-generation path and rejects an entire oversized or excess-call plan", () => {
    const { inputs, selection } = fictionalInputs(), plan = makePlan(inputs, selection);
    expect(generationBatches(plan, SYSTEM).map(count)).toEqual([1, 1]);
    expect(() => generationBatches(plan, "x".repeat(LIMITS.inputBytes))).toThrow("plan_limit");
    const c = compact(), padding = "x".repeat(LIMITS.inputBytes - bytes(prefix(c.plan, 1)));
    expect(() => generationBatches(c.plan, padding)).toThrow("plan_limit");
    expect(() => generationBatches([...c.plan, c.plan[0]], SYSTEM)).toThrow("plan_limit");
  });
});
