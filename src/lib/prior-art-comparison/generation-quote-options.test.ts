import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { parseComparisonSource, digest } from "./source";
import { decodeSourcePropositions, propositionSourceInput, type SourceExtraction } from "./proposition-extraction";
import { generationQuoteOptions, generationQuoteRanges, generationQuoteAllowance } from "./generation-quote-options";
import { generationInput, generationSchemaFor, decodeGeneration } from "./generation";
import { batchSchemaFor, batchTransportInput, requestBytes } from "./generation-batch";
import { SOURCE_CAPACITY } from "./source-capacity";
import type { Span } from "./propositions";

function fixture(prefix = "補".repeat(109)) {
  const f = fictionalInputs(), text = prefix + "装置は、温度が七度を超えると青色弁を閉じる。";
  f.inputs.draft = parseComparisonSource(`【請求項1】${text}`, 11, "架空基準");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(`【請求項1】${text}`, d.id, d.label));
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan), span = (term: string): Span => [text.indexOf(term), text.indexOf(term) + term.length];
  const raw: SourceExtraction = { sources: input.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: [{ claimNo: 1,
    basis: [[0, text.length]], meaning: { kind: "relation", subject: "装置", context: "operation", guard: { relation: "when", conditions: ["温度が七度を超える"] }, polarity: "positive", predicate: "closes", objects: ["青色弁"] },
    bindings: ["装置", "温度が七度を超える", "青色弁"].map(term => ({ term, spans: [span(term)] })),
    operators: { selection: null, extent: null, polarity: null, guard: span("温度が七度を超える"), context: null }, routeFrame: null }] })) };
  const actions = raw.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: s.facts.map(fact => ({ claimNo: 1, factDigest: digest(fact), action: span("閉じる") })) }));
  const decoded = decodeSourcePropositions(plan, raw, actions);
  return { text, plan, decoded, options: generationQuoteOptions(plan, decoded) };
}

it("adds an exact complete guard/action quote across an unchanged partition boundary and resolves its saved positions", () => {
  const f = fixture(), chunk = f.plan[0], prefix = `b${chunk.baseDigest}:0`, range = generationQuoteRanges(chunk.base, prefix, f.options)[0];
  const source = generationInput(chunk, f.options).base.claims[0];
  expect(source.segments.map(s => s.text).join("")).toBe(f.text);
  expect(source.segments.some(s => s.text.includes("装置は") && s.text.includes("閉じる"))).toBe(false);
  expect(range.start).toBe(109); expect(range.end - range.start).toBeLessThanOrEqual(120);
  const candidate = generationQuoteRanges(chunk.candidate, `c${chunk.candidateDigest}:${chunk.candidateId}`, f.options)[0];
  const row = { baseClaimNo: 1, candidateClaimNo: 1, baseObservation: "基準側の装置は温度が七度を超えると青色弁を閉じる。", candidateObservation: "候補側の装置は温度が七度を超えると青色弁を閉じる。", common: "基準側の装置は温度が七度を超えると青色弁を閉じる。候補側の装置は温度が七度を超えると青色弁を閉じる。", differences: "弁の配置は未確認。", unconfirmed: "弁の配置は未確認。", baseEvidenceId: range.id, candidateEvidenceId: candidate.id };
  expect(generationSchemaFor(chunk, f.options).safeParse({ results: [row] }).success).toBe(true);
  const saved = validateAnswer(chunk, decodeGeneration(chunk, { results: [row] }, f.options))[0];
  expect(saved.baseEvidence).toEqual({ claimNo: 1, start: range.start, end: range.end, quote: f.text.slice(range.start, range.end) });
  for (const id of [candidate.id, range.id + "0", range.id.replace(":1:", ":2:")]) expect(() => decodeGeneration(chunk, { results: [{ ...row, baseEvidenceId: id }] }, f.options)).toThrow("ai_incomplete");
});

it.each(["action", "guard", "original", "source_digest", "original_claim", "clone"])("rejects changed or unbranded decoder citations: %s", mode => {
  const f = fixture(), before = structuredClone(f.decoded);
  if (mode === "action") f.decoded.locators[0].action = [0, 1];
  if (mode === "guard") f.decoded.locators[0].quotes.pop();
  if (mode === "original") f.decoded.input.sources[0].source.claims[0].segments[0].text += "変更";
  if (mode === "source_digest") f.decoded.input.sources[0].sourceDigest = "0".repeat(64);
  if (mode === "original_claim") f.decoded.facts[0].claimNo = 2;
  expect(() => generationQuoteOptions(f.plan, mode === "clone" ? before : f.decoded)).toThrow("ai_incomplete");
});

it("binds the quote options to the current plan and exposes no rewritten source text", () => {
  const f = fixture(), changed = f.plan.map((c, i) => i ? c : { ...c, base: { ...c.base, claims: c.base.claims.map((claim, j) => j ? claim : { ...claim, text: claim.text + "変更" }) } });
  expect(() => generationQuoteOptions(changed, f.decoded)).toThrow("ai_incomplete");
  const wire = batchTransportInput(f.plan, [], f.options);
  expect(wire.base.claims[0].segments.map(s => s.text).join("")).toBe(f.text);
  expect(wire.base.claims[0].quoteRanges).toEqual([[109, f.text.indexOf("閉じる") + 3]]);
  const actual = requestBytes("", JSON.stringify(wire), batchSchemaFor(f.plan, f.options));
  const before = requestBytes("", JSON.stringify(batchTransportInput(f.plan)), batchSchemaFor(f.plan));
  expect(actual).toBeLessThanOrEqual(before + generationQuoteAllowance(f.plan));
  expect(generationQuoteAllowance(f.plan)).toBeGreaterThan(3 * SOURCE_CAPACITY.facts * 70);
});

it("keeps existing quotable choices when there is no additional bounded quote", () => {
  const f = fixture("装置" + "補".repeat(200));
  expect(Object.values(f.options).every(v => v.ranges.length === 0)).toBe(true);
  const schema = batchSchemaFor(f.plan, f.options);
  expect(schema.shape.results.element.shape.baseEvidenceId.options.length).toBeGreaterThan(0);
});

it("rejects a forged option set and a source changed after option construction", () => {
 const f = fixture(), chunk = f.plan[0], prefix = `b${chunk.baseDigest}:0`;
 expect(() => generationQuoteRanges(chunk.base, prefix, structuredClone(f.options))).toThrow("ai_incomplete");
 const changed = { ...chunk.base, claims: chunk.base.claims.map((c, i) => i ? c : { ...c, text: c.text + "変更" }) };
 expect(() => generationQuoteRanges(changed, prefix, f.options)).toThrow("ai_incomplete");
});
it("does not expose a repeated original envelope as a unique added quote", () => {
 const f = fixture("装置は、温度が七度を超えると青色弁を閉じる。");
 expect(Object.values(f.options).every(v => v.ranges.length === 0)).toBe(true);
});
it.each(["baseObservation", "candidateObservation", "common", "differences", "unconfirmed"] as const)("rejects quoteRanges protocol metadata in %s", field => {
 const f = fixture(), chunk = f.plan[0];
 const base = generationQuoteRanges(chunk.base, `b${chunk.baseDigest}:0`, f.options)[0];
 const candidate = generationQuoteRanges(chunk.candidate, `c${chunk.candidateDigest}:${chunk.candidateId}`, f.options)[0];
 const row = { baseClaimNo: 1, candidateClaimNo: 1, baseObservation: "基準側の装置は温度が七度を超えると青色弁を閉じる。", candidateObservation: "候補側の装置は温度が七度を超えると青色弁を閉じる。", common: "基準側の装置は温度が七度を超えると青色弁を閉じる。候補側の装置は温度が七度を超えると青色弁を閉じる。", differences: "弁の配置は未確認。", unconfirmed: "弁の配置は未確認。", baseEvidenceId: base.id, candidateEvidenceId: candidate.id };
 expect(() => decodeGeneration(chunk, { results: [{ ...row, [field]: "quoteRangesの範囲は未確認。" }] }, f.options)).toThrow("ai_incomplete");
});

/** All options here pass the real extraction decoder; no seal is fabricated. */
function rangeFixture(sentences: string[], inherited = false, minimal = false) {
 const f = fictionalInputs(), text = sentences.join("。") + "。";
 const sourceText = `【請求項1】${text}` + (inherited ? "\n【請求項2】請求項1に記載の装置。" : "");
 f.inputs.draft = parseComparisonSource(sourceText, 11, "架空基準");
 f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(sourceText, d.id, d.label));
 if (inherited) { f.inputs.documents = f.inputs.documents.slice(0, 1); f.selection.documents = f.selection.documents.slice(0, 1); f.selection.draftClaimNos = [1, 2]; f.selection.documents.forEach(d => { d.claimNos = [1, 2]; }); }
 const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan);
 const facts = sentences.map((sentence, i) => {
  const offset = sentences.slice(0, i).reduce((sum, s) => sum + s.length + 1, 0);
  const object = /青色弁\d*/u.exec(sentence)![0];
  const span = (term: string): Span => [offset + sentence.indexOf(term), offset + sentence.indexOf(term) + term.length];
  return { claimNo: 1, basis: [[offset, offset + sentence.length]] as Span[], meaning: { kind: "relation" as const, subject: "装置", context: "operation" as const, guard: { relation: minimal ? "unconditional" as const : "when" as const, conditions: minimal ? [] : ["温度が七度を超える"] }, polarity: "positive" as const, predicate: "closes" as const, objects: [object] }, bindings: ["装置", ...(minimal ? [] : ["温度が七度を超える"]), object].map(term => ({ term, spans: [span(term)] })), operators: { selection: null, extent: null, polarity: null, guard: minimal ? null : span("温度が七度を超える"), context: null }, routeFrame: null };
 });
 const raw: SourceExtraction = { sources: input.sources.map((s, i) => ({ sourceDigest: s.sourceDigest, facts: minimal && i > 0 ? [] : [...facts] })) };
 const actions = raw.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: s.facts.map((fact, i) => { const start = facts[i].basis[0][0] + sentences[i].indexOf("閉じる"); return { claimNo: 1, factDigest: digest(fact), action: [start, start + 3] as Span }; }) }));
 const decoded = decodeSourcePropositions(plan, raw, actions);
 return { plan, input, raw, actions, decoded, options: generationQuoteOptions(plan, decoded) };
}
it.each([120, 121])("keeps the exact %s character quote boundary", length => {
 const fixed = "装置は、温度が七度を超えると青色弁を閉じる";
 const f = rangeFixture([fixed.replace("は、", "は、" + "補".repeat(length - fixed.length))]);
 const ranges = generationQuoteRanges(f.plan[0].base, `b${f.plan[0].baseDigest}:0`, f.options);
 expect(ranges.length).toBe(length === 120 ? 1 : 0);
 if (ranges.length) expect(ranges[0].end - ranges[0].start).toBe(120);
});
it("retains different end offsets for two real facts with the same start", () => {
 const f = rangeFixture(["装置は、温度が七度を超えると青色弁を閉じる。その後も赤色弁を閉じる"]);
 const first = f.raw.sources[0].facts[0];
 for (const s of f.raw.sources) s.facts.push({ ...first, meaning: { ...first.meaning, objects: ["赤色弁"] }, bindings: first.bindings.map(b => b.term === "青色弁" ? { term: "赤色弁", spans: [[f.plan[0].base.claims[0].text.indexOf("赤色弁"), f.plan[0].base.claims[0].text.indexOf("赤色弁") + 3]] as Span[] } : b) });
 for (const s of f.actions) { const last = s.facts[0]; s.facts.push({ ...last, factDigest: digest(f.raw.sources[0].facts[1]), action: [f.plan[0].base.claims[0].text.lastIndexOf("閉じる"), f.plan[0].base.claims[0].text.lastIndexOf("閉じる") + 3] }); }
 const options = generationQuoteOptions(f.plan, decodeSourcePropositions(f.plan, f.raw, f.actions));
 const ranges = generationQuoteRanges(f.plan[0].base, `b${f.plan[0].baseDigest}:0`, options);
 expect(ranges.length).toBe(2); expect(ranges[0].start).toBe(ranges[1].start);
 expect(ranges[0].id === ranges[1].id).toBe(false);
});
it("deduplicates one locator shared by multiple inherited scopes", () => {
 const f = rangeFixture(["装置は、温度が七度を超えると青色弁を閉じる"], true);
 expect(f.decoded.facts.filter(f => f.id === "s0.0" && f.authority === "extracted").length).toBe(2);
 expect(generationQuoteRanges(f.plan[0].base, `b${f.plan[0].baseDigest}:0`, f.options).length).toBe(1);
});
it("bounds the actual wire with 96 valid facts on one source and reserves 96 for every source before extraction", () => {
 const f = rangeFixture(Array.from({ length: SOURCE_CAPACITY.facts }, (_, i) => `装置は青色弁${i}を閉じる`), false, true);
 expect(Object.values(f.options).map(o => o.ranges.length)).toEqual([96, 0, 0]);
 const before = requestBytes("", JSON.stringify(batchTransportInput(f.plan)), batchSchemaFor(f.plan));
 const actual = requestBytes("", JSON.stringify(batchTransportInput(f.plan, [], f.options)), batchSchemaFor(f.plan, f.options));
 expect(actual).toBeLessThanOrEqual(before + generationQuoteAllowance(f.plan));
});
it.each(["start", "end"])("rejects a split-surrogate action at real decoder admission: %s", boundary => {
 const f = rangeFixture(["装置は、温度が七度を超えると青色弁を閉じる😀"]);
 const at = f.plan[0].base.claims[0].text.indexOf("😀");
 for (const s of f.actions) s.facts[0].action = boundary === "start" ? [at + 1, at + 2] : [at, at + 1];
 expect(() => decodeSourcePropositions(f.plan, f.raw, f.actions)).toThrow("ai_incomplete");
});
