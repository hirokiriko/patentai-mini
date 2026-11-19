import { expect, it } from "vitest";
import { sourceReadingClaim } from "./source-clause-coverage";
import { assertSourceSemanticReading, sourceCompleteActionCues, type CheckedSourceFact } from "./source-semantic-check";
import { sourceClaimExtractionPlan } from "./source-claim-extraction";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import type { Span } from "./propositions";

function fact(text: string, predicate: string, action: string, object: string, last = false): CheckedSourceFact {
  const span = (quote: string): Span => { const at = last ? text.lastIndexOf(quote) : text.indexOf(quote); expect(at).toBeGreaterThanOrEqual(0); return [at, at + quote.length]; };
  return { kind: "relation", predicate, polarity: "positive", polarityProof: null, action: span(action), evidence: [[0, text.length]], objectSpans: [[span(object)]], guardSpans: [], guardProof: null, identity: predicate };
}
function check(text: string, facts: CheckedSourceFact[]) {
  const c = sourceReadingClaim(1, text); return assertSourceSemanticReading(c, facts, sourceCompleteActionCues(c));
}

it("rejects a maintained open state as a new opening without removing its checklist cue", () => {
  const text = "装置は、赤弁が開いた状態を維持する。", c = sourceReadingClaim(1, text);
  expect(sourceCompleteActionCues(c).some(cue => cue.predicate === "opens")).toBe(true);
  expect(() => check(text, [fact(text, "opens", "開いた", "赤弁")])).toThrow();
  expect(() => check(text, [fact(text, "maintains", "赤弁が開いた状態を維持する", "赤弁が開いた状態を維持する")])).not.toThrow();
});

it.each(["制御器は、青弁を開き、装置は赤弁が開いた状態を維持する。", "装置は、赤弁を開き、赤弁が開いた状態を維持する。"]) (
  "does not borrow an earlier active opening through a broad action quote: %s", text => {
    expect(() => check(text, [fact(text, "opens", text.slice(0, -1), "赤弁", true)])).toThrow();
  },
);

it("retains a separate active opening and a complete maintained state at their own occurrences", () => {
  const text = "装置は、青弁を開き、赤弁が開いた状態を維持する。";
  expect(() => check(text, [fact(text, "opens", "開き", "青弁"), fact(text, "maintains", "赤弁が開いた状態を維持する", "赤弁が開いた状態を維持する")])).not.toThrow();
});

it("keeps an explicitly active open and does not reclassify opening followed by a later maintenance", () => {
  for (const text of ["装置は、弁を開く。", "装置は、弁を開いた後でその状態を維持する。"])
    expect(() => check(text, [fact(text, "opens", text.includes("開く") ? "開く" : "開いた", "弁")])).not.toThrow();
});

it("rejects a later maintained occurrence even when the same action word appears earlier", () => {
  const text = "装置は、弁を開き、弁が開いた状態を維持する。";
  expect(() => check(text, [fact(text, "opens", "開いた", "弁", true)])).toThrow();
});

it("aligns source task obligations with the already supported complete maintains alternative", () => {
  const f = fictionalInputs(), text = "【請求項1】装置は、赤弁が開いた状態を維持する。";
  f.inputs.draft = parseComparisonSource(text, 11, "架空");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(text, d.id, "架空"));
  const plan = sourceClaimExtractionPlan(makePlan(f.inputs, f.selection));
  for (const task of plan.tasks) {
    expect(task.system).toContain("an opens/closes checklist literal inside a maintained state is covered by maintains");
    expect(task.system).toContain("not an independent opens fact");
    expect(task.system).toContain("at its own occurrence");
    expect(task.prompt).toContain("開いた");
  }
});
