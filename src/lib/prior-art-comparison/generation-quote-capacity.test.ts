import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, SYSTEM } from "./comparison";
import { digest, parseComparisonSource } from "./source";
import { generationBatches, batchSchemaFor, batchTransportInput, requestBytes } from "./generation-batch";
import { decodeSourcePropositions, propositionSourceInput, type SourceExtraction } from "./proposition-extraction";
import { generationQuoteAllowance, generationQuoteEnumAllowance, generationQuoteOptions } from "./generation-quote-options";

function fixture(documents = 3) {
  const f = fictionalInputs(), terms = Array.from({ length: 85 }, (_, i) => String.fromCharCode(0x4e00 + i)), text = terms.join("、") + "。";
  f.inputs.draft = parseComparisonSource(`【請求項1】${text}`, 11, "基準");
  f.inputs.documents = Array.from({ length: documents }, (_, i) => parseComparisonSource(`【請求項1】${text}`, 21 + i, `架空${i}`));
  f.selection.documents = f.inputs.documents.map(d => ({ docId: d.id, claimNos: [1], identity: { publication: d.label, edition: "架空" } }));
  const plan = f.selection.documents.flatMap(d => makePlan(f.inputs, { ...f.selection, documents: [d] }));
  const options = (chunks: typeof plan) => {
    const input = propositionSourceInput(chunks);
    const raw: SourceExtraction = { sources: input.sources.map((s, i) => ({ sourceDigest: s.sourceDigest, facts: i === 0 ? [] : terms.map(term => ({
      claimNo: 1, basis: [[0, text.length]], meaning: { kind: "set", subject: null, context: "capability", guard: { relation: "unconditional", conditions: [] }, polarity: "positive", extent: "closed", selection: "all", members: [term] },
      bindings: [{ term, spans: [[text.indexOf(term), text.indexOf(term) + 1]] }], operators: { selection: null, extent: null, polarity: null, guard: null, context: null }, routeFrame: null,
    })) })) };
    return generationQuoteOptions(chunks, decodeSourcePropositions(chunks, raw));
  };
  return { plan, options, text, inputs: f.inputs, selection: f.selection };
}

it("packs three candidate enums before extraction while retaining all 85 valid decoded quotes per candidate", () => {
  const f = fixture(), allOptions = f.options(f.plan);
  expect(Object.values(allOptions).map(o => o.ranges.length)).toEqual([0, 85, 85, 85]);
  // Bytes alone fitted the old packing decision, but the realized enum cannot.
  expect(requestBytes(SYSTEM, JSON.stringify(batchTransportInput(f.plan)), batchSchemaFor(f.plan)) + generationQuoteAllowance(f.plan)).toBeLessThan(120000);
  expect(() => batchSchemaFor(f.plan, allOptions)).toThrow("plan_limit");
  expect(() => makePlan(f.inputs, f.selection)).toThrow("plan_limit");
  const batches = generationBatches(f.plan, SYSTEM);
  expect(batches.map(b => b.length)).toEqual([2, 1]);
  expect(batches.flatMap(b => b.flatMap(c => c.pairs.map(p => [c.candidateId, p])))).toEqual(f.plan.flatMap(c => c.pairs.map(p => [c.candidateId, p])));
  for (const batch of batches) {
    const options = f.options(batch), schema = batchSchemaFor(batch, options), legacy = batchSchemaFor(batch), extra = generationQuoteEnumAllowance(batch);
    for (const side of ["base", "candidate"] as const) {
      const actual = side === "base" ? schema.shape.results.element.shape.baseEvidenceId.options : schema.shape.results.element.shape.candidateEvidenceId.options;
      const prior = side === "base" ? legacy.shape.results.element.shape.baseEvidenceId.options : legacy.shape.results.element.shape.candidateEvidenceId.options;
      expect(actual.length).toBeLessThanOrEqual(prior.length + extra[side].count);
      expect(actual.join("").length).toBeLessThanOrEqual(prior.join("").length + extra[side].characters);
    }
    expect(Object.values(options).filter(o => o.ranges.length > 0).every(o => o.ranges.length === 85)).toBe(true);
    expect(schema.shape.results.element.shape.candidateEvidenceId.options.length).toBeGreaterThanOrEqual(batch.length * 85);
    expect(batch.every(c => c.candidate.claims[0].text === f.text)).toBe(true);
  }
});

it("keeps two candidates in one batch and counts a repeated source prefix only once", () => {
  const f = fixture(2), batches = generationBatches(f.plan, SYSTEM);
  expect(batches.length).toBe(1);
  expect(generationQuoteEnumAllowance(f.plan)).toEqual(generationQuoteEnumAllowance([...f.plan, f.plan[0]]));
  expect(generationQuoteEnumAllowance(f.plan).candidate.count).toBe(192);
  expect(generationQuoteEnumAllowance(f.plan).base.count).toBe(96);
  expect(batchSchemaFor(batches[0], f.options(batches[0])).shape.results.element.shape.candidateEvidenceId.options.length).toBeGreaterThanOrEqual(170);
  expect(digest(f.plan)).toBe(digest(batches[0]));
});
