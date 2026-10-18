import { describe, expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, SYSTEM } from "./comparison";
import { generationBatches } from "./generation-batch";
import { mergeSourceAnalyses, sourceAnalysisInput, validateSourceAnalysis } from "./source-analysis";

const material = () => {
  const { inputs, selection } = fictionalInputs();
  return generationBatches(makePlan(inputs, selection), SYSTEM)[0];
};
const notesFor = (batch: ReturnType<typeof material>) => sourceAnalysisInput(batch).sources.map(s => ({
  sourceDigest: s.sourceDigest, reading: "架空索引。意味品質の証明ではない。",
}));

describe("original-only analysis boundary", () => {
  it("whitelists full planned originals and scope, without draft or quote choices", () => {
    const batch = material(), input = sourceAnalysisInput(batch);
    expect(Object.keys(input)).toEqual(["task", "sources"]);
    expect(input.task).toBe("read_sources");
    const sources = [batch[0].base, ...batch.map(c => c.candidate)];
    input.sources.forEach((s, i) => {
      expect(Object.keys(s)).toEqual(["sourceDigest", "side", "docId", "selected", "source"]);
      expect(s.source.claims.map(c => c.segments.map(part => part.text).join("")))
        .toEqual(sources[i].claims.map(c => c.text));
    });
    expect(JSON.stringify(input)).not.toMatch(/baseObservation|candidateObservation|counterEvidence|targetQuote|unitId|sourceComparison|verdict/);
  });

  it.each(["missing", "reordered", "duplicate", "foreign", "blank", "control", "overlong"])("rejects %s analysis before another stage", mode => {
    const batch = material(), notes = notesFor(batch), before = JSON.stringify(notes);
    expect(validateSourceAnalysis(batch, notes)).toEqual(notes);
    expect(JSON.stringify(notes)).toBe(before);
    if (mode === "missing") notes.pop();
    if (mode === "reordered") notes.reverse();
    if (mode === "duplicate") notes[1] = { ...notes[0] };
    if (mode === "foreign") notes[0].sourceDigest = "f".repeat(64);
    if (mode === "blank") notes[0].reading = "　 ";
    if (mode === "control") notes[0].reading += "\n";
    if (mode === "overlong") notes[0].reading = "甲".repeat(91);
    expect(() => validateSourceAnalysis(batch, notes)).toThrow("ai_incomplete");
  });

  it("retains differing readings of an identical scope without choosing or rewriting", () => {
    const first = notesFor(material()), second = first.map(n => ({ ...n, reading: "異なる架空索引。原文による再確認が必要。" }));
    const before = JSON.stringify([first, second]);
    expect(mergeSourceAnalyses([first, second])).toEqual([...first, ...second]);
    expect(JSON.stringify([first, second])).toBe(before);
  });
});
