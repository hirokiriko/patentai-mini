import { expect, it } from "vitest";
import { makePlan, validateAnswer } from "./comparison";
import { fictionalInputs } from "./fixtures.test-support";
import { parseComparisonSource, digest } from "./source";
import { decodeSourcePropositions, propositionSourceInput, type SourceExtraction } from "./proposition-extraction";
import { generationQuoteOptions } from "./generation-quote-options";
import { decodeFactSelection } from "./fact-selection-generation";
import { decodeGeneration } from "./generation";
import type { Span } from "./propositions";

function fixture() {
  const f = fictionalInputs(), parent = "制御器は、温度が七度を超えると青色弁を閉じる。";
  const child = "前記制御器は、逆流防止制御を開始する際に両弁を同時に開く。";
  f.inputs.draft = parseComparisonSource(`【請求項1】${parent}`, f.inputs.draft.id, f.inputs.draft.label);
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(`【請求項1】${parent}\n【請求項2】${child}請求項1に記載の装置。`, d.id, d.label));
  f.selection.documents.forEach(d => { d.claimNos = [2]; });
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan);
  const raw: SourceExtraction = { sources: input.sources.map(s => ({ sourceDigest: s.sourceDigest,
    facts: s.source.claims.map(c => {
      const text = c.segments.map(p => p.text).join(""), childFact = c.claimNo === 2;
      const subject = childFact ? "前記制御器" : "制御器", condition = childFact ? "逆流防止制御を開始する際" : "温度が七度を超える", object = childFact ? "両弁" : "青色弁";
      const span = (term: string): Span => [text.indexOf(term), text.indexOf(term) + term.length];
      return { claimNo: c.claimNo, basis: [[0, text.length] as Span], meaning: { kind: "relation", subject,
        context: "operation", guard: { relation: "when", conditions: [condition] }, polarity: "positive",
        predicate: childFact ? "opens_together" : "closes", objects: [object] },
        bindings: [subject, condition, object].map(term => ({ term, spans: [span(term)] })),
        operators: { selection: null, extent: null, polarity: null, guard: span(condition), context: null }, routeFrame: null };
    }) })) };
  const actions = raw.sources.map(s => ({ sourceDigest: s.sourceDigest, facts: s.facts.map(fact => {
    const text = input.sources.find(v => v.sourceDigest === s.sourceDigest)!.source.claims.find(c => c.claimNo === fact.claimNo)!.segments.map(p => p.text).join("");
    const action = fact.claimNo === 2 ? "同時に開く" : "閉じる";
    return { claimNo: fact.claimNo, factDigest: digest(fact), action: [text.indexOf(action), text.indexOf(action) + action.length] as Span };
  }) }));
  const sources = decodeSourcePropositions(plan, raw, actions), quotes = generationQuoteOptions(plan, sources);
  const selection = { results: plan.flatMap((c, i) => c.pairs.map(pair => ({ docId: c.candidateId, ...pair,
    baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.1`],
    common: [{ baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.0`] }],
    differences: { baseFacts: ["s0.0"], candidateFacts: [`s${i + 1}.1`] }, unconfirmed: "比較結果の原文照合は要確認。" }))) };
  return { plan, sources, quotes, selection };
}

it("selects full literal actors/guards, keeps parent and child separate, and resolves the child quote", () => {
  const f = fixture(), before = JSON.stringify(f.sources), answer = decodeFactSelection(f.plan, f.sources, f.quotes, f.selection);
  expect(JSON.stringify(f.sources)).toBe(before);
  for (const chunk of f.plan) {
    const results = answer.results.filter(r => r.docId === chunk.candidateId);
    expect(results[0].baseObservation).toContain("条件「温度が七度を超える」のとき、制御器は");
    expect(results[0].candidateObservation).toContain("条件「逆流防止制御を開始する際」のとき、前記制御器は");
    expect(results[0].candidateObservation).not.toContain("温度");
    const saved = validateAnswer(chunk, decodeGeneration(chunk, { results: results.map(({ docId: _, ...r }) => r) }, f.quotes));
    expect(saved[0].candidateEvidence.claimNo).toBe(2);
    expect(saved[0].candidateEvidence.quote).toContain("前記制御器は、逆流防止制御を開始する際に両弁を同時に開く");
  }
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
