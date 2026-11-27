import { expect, it } from "vitest";
import { createAzure } from "@ai-sdk/azure";
import { generateObject } from "ai";
import { makePlan, validateAnswer } from "./comparison";
import { fictionalInputs } from "./fixtures.test-support";
import { parseComparisonSource, digest } from "./source";
import { decodeSourcePropositions, propositionSourceInput, type SourceExtraction } from "./proposition-extraction";
import { generationQuoteOptions } from "./generation-quote-options";
import { decodeFactSelection, factControlCoverage, factObservationChoices, generationSelectionSchema, factSelectionSchema } from "./fact-selection-generation";
import { comparisonModelSchema } from "./model-schema";
import { decodeGeneration } from "./generation";
import { renderMeaning } from "./proposition-result";
import type { Span } from "./propositions";

function keyedResults(rows: { docId: number; baseClaimNo: number; candidateClaimNo: number; differences: unknown }[]) {
  return Object.fromEntries(rows.map(({ docId, baseClaimNo, candidateClaimNo, ...fields }) =>
    [`doc${docId}_base${baseClaimNo}_candidate${candidateClaimNo}`, fields]));
}

function fixture(distinctParent = false) {
  const f = fictionalInputs(), parent = "制御器は、温度が七度を超えると青色弁を閉じる。";
  const child = "前記制御器は、逆流防止制御を開始する際に両弁を同時に開く。";
  const longCondition = "高温の検出が続き、".repeat(5) + "規定時間を超えた場合";
  const candidateParent = distinctParent ? parent.replace("温度が七度を超える", longCondition) : parent;
  f.inputs.draft = parseComparisonSource(`【請求項1】${parent}${distinctParent ? child : ""}`, f.inputs.draft.id, f.inputs.draft.label);
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(`【請求項1】${candidateParent}\n【請求項2】${child}請求項1に記載の装置。`, d.id, d.label));
  f.selection.documents.forEach(d => { d.claimNos = [2]; });
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan);
  const raw: SourceExtraction = { sources: input.sources.map(s => ({ sourceDigest: s.sourceDigest,
    facts: s.source.claims.flatMap(c => {
      const text = c.segments.map(p => p.text).join("");
      const actions = distinctParent && s.side === "base" ? [false, true] : [c.claimNo === 2];
      return actions.map((childFact): SourceExtraction["sources"][number]["facts"][number] => {
        const subject = childFact ? "前記制御器" : "制御器";
        const condition = childFact ? "逆流防止制御を開始する際" : text.includes(longCondition) ? longCondition : "温度が七度を超える";
        const object = childFact ? "両弁" : "青色弁";
        const span = (term: string): Span => [text.indexOf(term), text.indexOf(term) + term.length];
        return { claimNo: c.claimNo, basis: [[0, text.length] as Span], meaning: { kind: "relation", subject,
          context: "operation", guard: { relation: "when", conditions: [condition] }, polarity: "positive",
          predicate: childFact ? "opens_together" : "closes", objects: [object] },
          bindings: [subject, condition, object].map(term => ({ term, spans: [span(term)] })),
          operators: { selection: null, extent: null, polarity: null, guard: span(condition), context: null }, routeFrame: null };
      });
    }) })) };
  const actions = raw.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: s.facts.map(fact => {
    const text = input.sources.find(v => v.sourceDigest === s.sourceDigest)!.source.claims.find(c => c.claimNo === fact.claimNo)!.segments.map(p => p.text).join("");
    const action = fact.meaning.kind === "relation" && fact.meaning.predicate === "opens_together" ? "同時に開く" : "閉じる";
    return { claimNo: fact.claimNo, factDigest: digest(fact), action: [text.indexOf(action), text.indexOf(action) + action.length] as Span };
  }) }));
  const sources = decodeSourcePropositions(plan, raw, actions), quotes = generationQuoteOptions(plan, sources);
  const selection = { results: plan.flatMap((c, i) => c.pairs.map(pair => ({ docId: c.candidateId, ...pair,
    baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.1`],
    common: [{ baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.0`] }],
    differences: { baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.1`] }, unconfirmed: "比較結果の原文照合は要確認。" }))) };
  return { plan, sources, quotes, selection };
}

it("restores a length-dispatched bundle and rejects a false length annotation", () => {
  const f = fixture(), original = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  const fact = f.sources.facts.find(fact => fact.id === "s0.0")!;
  const length = (`基準側は、${renderMeaning(fact.meaning)}。`).length;
  const value = { results: f.selection.results.map(result => ({ ...result,
    differences: { [`baseFactsLength${length}`]: JSON.stringify(result.differences.baseFacts),
      candidateFacts: JSON.stringify(result.differences.candidateFacts) } })) };
  expect(decodeFactSelection(f.plan, f.sources, f.quotes, value)).toEqual(original);
  value.results[0].differences = { baseFactsLength1: JSON.stringify(["s0.0"]), candidateFacts: JSON.stringify(["s1.1"]) };
  expect(() => decodeFactSelection(f.plan, f.sources, f.quotes, value)).toThrow("ai_incomplete");
});

it("selects full literal actors/guards, keeps parent and child separate, and resolves the child quote", () => {
  const f = fixture(), before = JSON.stringify(f.sources), answer = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  expect(JSON.stringify(f.sources)).toBe(before);
  for (const chunk of f.plan) {
    const results = answer.results.filter(r => r.docId === chunk.candidateId);
    expect(results[0].baseObservation).toContain("条件「温度が七度を超える」のとき、制御器は");
    expect(results[0].candidateObservation).toContain("条件「逆流防止制御を開始する際」のとき、前記制御器は");
    expect(results[0].candidateObservation).not.toContain("温度");
    const saved = validateAnswer(chunk, decodeGeneration(chunk, { results: results.map(({ docId: ignored, ...r }) => { void ignored; return r; }) }, f.quotes));
    expect(saved[0].candidateEvidence.claimNo).toBe(2);
    expect(saved[0].candidateEvidence.quote).toContain("前記制御器は、逆流防止制御を開始する際に両弁を同時に開く");
  }
});

it("requires an explicit parent difference only for the pair where no other field can show that control", () => {
  const f = fixture();
  const observations = factObservationChoices(f.plan, f.sources, f.quotes);
  const parent = f.sources.facts.find(fact => fact.id === "s1.0")!;
  // A long, distinct parent control cannot fit as a second observation.
  // The other document's parent still has an exact common fact.
  parent.meaning.guard = { relation: "when", conditions: ["高温の検出が続き、".repeat(5) + "規定時間を超えた場合"] };
  const schema = generationSelectionSchema(f.plan, f.sources, observations, factControlCoverage(f.sources));
  expect(schema.safeParse({ results: [f.selection.results[1], f.selection.results[1]] }).success).toBe(false);
  expect(schema.safeParse(f.selection).success).toBe(false);
  const first = f.selection.results[0];
  const baseLengthKey = "baseFactsLength" + ("基準側は、" + renderMeaning(f.sources.facts.find(fact => fact.id === "s0.0")!.meaning) + "。").length;
  const explicit = { results: keyedResults([{ ...first, differences: { [baseLengthKey]: JSON.stringify(first.differences.baseFacts),
    candidateFacts: JSON.stringify(["s1.0"]) } }, f.selection.results[1]]) };
  expect(schema.safeParse(explicit).success).toBe(true);
  const wire = comparisonModelSchema<unknown>(schema);
  expect(JSON.stringify(wire.jsonSchema)).toContain('s1.0');
  const [left, right] = Object.keys(explicit.results);
  expect(schema.safeParse({ results: { [right]: explicit.results[right] } }).success).toBe(false);
  expect(schema.safeParse({ results: { ...explicit.results, other: explicit.results[right] } }).success).toBe(false);
  expect(schema.safeParse({ results: { ...explicit.results, [left]: explicit.results[right] } }).success).toBe(false);
  explicit.results[left].differences = { [baseLengthKey]: JSON.stringify(first.differences.baseFacts), candidateFacts: JSON.stringify(["s1.1"]) };
  expect(schema.safeParse(explicit).success).toBe(false);
});

it("reads required pair slots in plan order and preserves legacy decoded claims and quotes", () => {
  const f = fixture(), original = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  const results = keyedResults([...f.selection.results].reverse());
  expect(decodeFactSelection(f.plan, f.sources, f.quotes, { results })).toEqual(original);
  const [first, second] = Object.keys(results);
  for (const wrong of [
    { [first]: results[first] }, { [first]: results[first], foreign: results[second] },
    { ...results, foreign: results[second] }, { ...results, [first]: results[second] },
    { ...results, [first]: { ...results[first], docId: 1 } },
  ]) expect(() => decodeFactSelection(f.plan, f.sources, f.quotes, { results: wrong })).toThrow("ai_incomplete");
});

it("serializes two constrained pairs sharing the same base claim and keeps their candidate choices separate", () => {
  const f = fixture();
  for (const id of ["s1.0", "s2.0"]) {
    const parent = f.sources.facts.find(fact => fact.id === id)!;
    parent.meaning.guard = { relation: "when", conditions: ["高温の検出が続き、".repeat(5) + "規定時間を超えた場合"] };
  }
  const schema = generationSelectionSchema(f.plan, f.sources,
    factObservationChoices(f.plan, f.sources, f.quotes), factControlCoverage(f.sources));
  const wire = comparisonModelSchema<unknown>(schema).jsonSchema;
  const base = f.sources.facts.find(fact => fact.id === "s0.0")!;
  const field = "baseFactsLength" + (`基準側は、${renderMeaning(base.meaning)}。`).length;
  const results = keyedResults(f.selection.results.map((row, i) => ({ ...row,
    differences: { [field]: '["s0.0"]', candidateFacts: JSON.stringify([`s${i + 1}.0`]) },
  })));
  expect(wire).toMatchObject({ properties: { results: { type: "object", required: Object.keys(results) } } });
  expect(schema.safeParse({ results }).success).toBe(true);
  const [left, right] = Object.keys(results);
  expect(schema.safeParse({ results: { ...results, [right]: results[left] } }).success).toBe(false);
});

it("reads two constrained SDK response slots into comparisons with the selected child quotations", async () => {
  const f = fixture(true);
  const shape = generationSelectionSchema(f.plan, f.sources, factObservationChoices(f.plan, f.sources, f.quotes),
    factControlCoverage(f.sources));
  const parent = f.sources.facts.find(fact => fact.id === "s1.0")!;
  const lengthField = "candidateFactsLength" + (`候補側は、${renderMeaning(parent.meaning)}。`).length;
  const rows = f.selection.results.map((row, i) => ({ ...row,
    common: [{ baseFacts: ["s0.1"], candidateFacts: [`s${i + 1}.1`] }],
    differences: { baseFacts: '["s0.0"]', [lengthField]: JSON.stringify([`s${i + 1}.0`]) },
  }));
  const results = keyedResults(rows);
  let requests = 0;
  const azure = createAzure({ resourceName: "fictional", apiKey: "fictional", fetch: async (_url, init) => {
    requests++;
    const sent = JSON.parse(String(init?.body));
    expect(sent.text.format.schema.properties.results).toMatchObject({ type: "object", required: Object.keys(results) });
    return Response.json({ id: "resp_fixture", model: "fictional", created_at: 0, status: "completed",
      output: [{ type: "message", id: "msg_fixture", role: "assistant", status: "completed",
        content: [{ type: "output_text", text: JSON.stringify({ results }), annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1 } });
  } });
  const response = await generateObject({ model: azure.responses("fictional"), prompt: "Select both fictional pairs.",
    schema: comparisonModelSchema<unknown>(shape), maxRetries: 0 });
  expect(requests).toBe(1);
  const decoded = decodeFactSelection(f.plan, f.sources, f.quotes, response.object);
  expect(decoded.results.map(row => row.docId)).toEqual(f.plan.map(chunk => chunk.candidateId));
  for (const [index, chunk] of f.plan.entries()) {
    const { docId, ...row } = decoded.results[index];
    expect(docId).toBe(chunk.candidateId);
    const [pair] = validateAnswer(chunk, decodeGeneration(chunk, { results: [row] }, f.quotes));
    expect(pair.candidateEvidence.claimNo).toBe(2);
    expect(pair.candidateEvidence.quote).toContain("両弁を同時に開く");
    expect(row.differences).toContain("規定時間を超えた場合");
  }
});

it("renders only the control and optional second fact the model explicitly chose", () => {
  const f = fixture(), result = f.selection.results[0];
  const original = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  const withSlot = (controlFactId: string, additionalFactId: string | null) => ({ results: [
    { ...result, differences: { baseFacts: result.differences.baseFacts, candidateFacts: { controlFactId, additionalFactId } } },
    f.selection.results[1],
  ] });
  expect(decodeFactSelection(f.plan, f.sources, f.quotes, withSlot("s1.1", null))).toEqual(original);
  for (const extra of ["s1.1", "s999.0"]) {
    expect(() => decodeFactSelection(f.plan, f.sources, f.quotes, withSlot("s1.1", extra))).toThrow("ai_incomplete");
  }
});

it("decodes exact budget bundles while preserving legacy selections and the child quote", () => {
  const f = fixture(), legacy = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  const encoded = structuredClone(f.selection) as unknown as { results: Record<string, unknown>[] };
  for (const result of encoded.results) {
    const difference = result.differences as { baseFacts: string[]; candidateFacts: string[] };
    result.differences = { baseFacts: JSON.stringify(difference.baseFacts), candidateFacts: JSON.stringify(difference.candidateFacts) };
  }
  expect(decodeFactSelection(f.plan, f.sources, f.quotes, encoded)).toEqual(legacy);
  const schema = generationSelectionSchema(f.plan, f.sources,
    factObservationChoices(f.plan, f.sources, f.quotes), factControlCoverage(f.sources));
  expect(schema).toBe(factSelectionSchema);
  expect(schema.safeParse(f.selection).success).toBe(true);
  expect(legacy.results[0].candidateEvidenceId).toContain(":2:");
});

it.each(["wrong_scope", "missing_fact", "duplicate", "wrong_common", "raw_prose", "missing_pair", "duplicate_pair", "parent_as_selected_child", "identical_difference"])("rejects invalid selections: %s", mode => {
  const f = fixture(), value = structuredClone(f.selection);
  if (mode === "wrong_scope") value.results[0].baseFacts = ["s1.0"];
  if (mode === "missing_fact") value.results[0].candidateFacts = ["s999.0"];
  if (mode === "duplicate") value.results[0].baseFacts.push("s0.0");
  if (mode === "wrong_common") value.results[0].common[0].candidateFacts = ["s1.1"];
  if (mode === "raw_prose") Object.assign(value.results[0], { baseObservation: "主語を省く。" });
  if (mode === "missing_pair") value.results.pop();
  if (mode === "duplicate_pair") value.results[1] = value.results[0];
  if (mode === "parent_as_selected_child") value.results[0].candidateFacts = ["s1.0"];
  if (mode === "identical_difference") value.results[0].differences.candidateFacts = ["s1.0"];
  expect(() => decodeFactSelection(f.plan, f.sources, f.quotes, value)).toThrow("ai_incomplete");
});

it("rejects source mutation rather than using it to invent a shorter or actorless selected sentence", () => {
  const f = fixture();
  f.sources.facts[0].meaning.subject = null;
  expect(() => decodeFactSelection(f.plan, f.sources, f.quotes, f.selection)).toThrow("ai_incomplete");
});

it.each(["power_ends", "is_state"] as const)("keeps valid actorless passive %s without inserting an active device", predicate => {
  const f = fictionalInputs(), text = predicate === "power_ends" ? "青色弁への給電が断たれる。" : "電源が供給される。";
  f.inputs.draft = parseComparisonSource(`【請求項1】${text}`, f.inputs.draft.id, f.inputs.draft.label);
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(`【請求項1】${text}`, d.id, d.label));
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan), object = predicate === "power_ends" ? "青色弁" : text.slice(0, -1);
  const raw: SourceExtraction = { sources: input.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: [{ claimNo: 1,
    basis: [[0, text.length]], meaning: { kind: "relation", subject: null, context: "operation", polarity: "positive",
      guard: { relation: "unconditional", conditions: [] }, predicate, objects: [object] },
    bindings: [{ term: object, spans: [[0, object.length]] }], operators: { selection: null, extent: null, polarity: null, guard: null, context: null }, routeFrame: null }] })) };
  const sources = decodeSourcePropositions(plan, raw), quotes = generationQuoteOptions(plan, sources);
  const results = plan.map((c, i) => ({ docId: c.candidateId, baseClaimNo: 1, candidateClaimNo: 1,
    baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.0`], common: [{ baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.0`] }],
    differences: { reservation: "制御条件の差異は未確認。" }, unconfirmed: "比較結果の原文照合は要確認。" }));
  const answer = decodeFactSelection(plan, sources, quotes, { results });
  expect(answer.results[0].baseObservation).not.toContain("装置は");
  expect(answer.results[0].baseObservation).toContain(predicate === "power_ends" ? "青色弁への給電が断たれる" : "電源が供給される");
});
