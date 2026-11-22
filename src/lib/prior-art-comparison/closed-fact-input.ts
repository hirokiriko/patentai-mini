import type { DecodedSources, PropositionTargetInput } from "./proposition-extraction";
import { meaningKey } from "./propositions";
import { renderMeaning } from "./proposition-result";

/** Input guidance, never a repaired response or an alternative proof. Original
 * facts/claims/quote choices remain present and the usual validators still run. */
export function closedFactInput(sources: DecodedSources) {
  const facts = sources.facts.map(f => {
    let sentence: string | null = null;
    try { sentence = `${renderMeaning(f.meaning)}。`; } catch { /* unresolved is not a candidate */ }
    return { id: f.id, scope: f.scope, claimNo: f.claimNo, basis: f.basis,
      meaning: f.meaning, sentence };
  });
  const scopes = sources.input.sources.flatMap(source => source.scopes.map(scope => {
    const node = scope.nodes.find(n => n.claimNo === scope.selected);
    const required = node?.guaranteed ?? [];
    // An ANY branch is not a conjunctive closure. Do not invent its conditions.
    const conjunctive = scope.nodes.every(n => n.relation !== "any_of" && n.relation !== "unresolved");
    const claims = required.map(claimNo => {
      const original = source.source.claims.find(c => c.claimNo === claimNo);
      return { claimNo, original: original?.segments.map(s => s.text).join("") ?? null,
        facts: facts.filter(f => f.scope === scope.id && f.claimNo === claimNo) };
    });
    return { scope: scope.id, selectedClaimNo: scope.selected, requiredClaimNos: required,
      closed: conjunctive && required.length > 0 && claims.every(c => c.original !== null &&
        c.facts.length > 0 && c.facts.every(f => f.sentence !== null)),
      claims };
  }));
  // Only offer IDs whose original claims and sentences are present in the
  // packet. An optional parent in an alternative branch cannot prove a common fact.
  const indexed = scopes.map(scope => {
    const ids = new Map<string, string[]>();
    for (const claim of scope.claims) for (const fact of claim.facts) {
      if (!fact.sentence || fact.meaning.subject === null) continue;
      const key = meaningKey(fact.meaning);
      const group = ids.get(key);
      if (group) group.push(fact.id);
      else ids.set(key, [fact.id]);
    }
    return { scope, ids };
  });
  const bases = indexed.filter(entry => entry.scope.scope.startsWith("base:"));
  return indexed.map(({ scope, ids }) => {
    const commonFactPairs = scope.scope.startsWith("base:") ? [] : bases.flatMap(base =>
      Array.from(ids).flatMap(([key, candidateIds]) => {
        const baseIds = base.ids.get(key);
        return baseIds ? [{ baseScope: base.scope.scope, candidateScope: scope.scope, baseIds, candidateIds }] : [];
      }));
    return { ...scope, commonFactPairs };
  });
}

export function reviewSupportInput(input: PropositionTargetInput) {
  return input.sourcePropositions.map(f => ({ id: f.id, scope: f.scope, claimNo: f.claimNo,
    subject: f.meaning.subject, context: f.meaning.context, kind: f.meaning.kind,
    guard: f.meaning.guard,
    predicate: f.meaning.kind === "relation" ? f.meaning.predicate : null,
    objects: f.meaning.kind === "relation" ? f.meaning.objects : null,
    contraryEvidence: "retain_existing_contradiction_rules_do_not_change_target",
    supportSelection: f.meaning.kind === "relation" ? "single_fact_same_subject_context_guard_predicate_objects" :
      "typed_existing_multi_fact_rules_no_unrelated_facts" }));
}
