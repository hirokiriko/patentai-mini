import type { DecodedSources, PropositionTargetInput } from "./proposition-extraction";
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
  return sources.input.sources.flatMap(source => source.scopes.map(scope => {
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
