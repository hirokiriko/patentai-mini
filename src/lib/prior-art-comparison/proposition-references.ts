import type { ManagedClaimSet } from "../patent-watch/managed-claims";
import { buildReferenceLogicGuide, type ReferenceRelation } from "./reference-logic";
import { ComparisonError } from "./source";

export type PropositionScope = {
  id: string; selected: number;
  nodes: { claimNo: number; refs: readonly number[]; relation: ReferenceRelation; guaranteed: readonly number[] }[];
};

/** Preserve the reference DAG. Enumerating every complete alternative can grow
 * exponentially even when the complete original is comfortably within budget. */
export function propositionScope(source: ManagedClaimSet, selected: number, id: string): PropositionScope {
  const guide = buildReferenceLogicGuide(source, [selected]);
  if (!guide.scopes[0].fullyResolved) throw new ComparisonError("source_review_required");
  return { id, selected, nodes: guide.claims.map(c => ({ claimNo: c.claimNo, refs: c.directRefs, relation: c.relation,
    guaranteed: buildReferenceLogicGuide(source, [c.claimNo]).scopes[0].guaranteedClaimNos! })) };
}

/** A proof is local to one original claim. Identical propositions established
 * in several claims cover a selected scope iff every legal alternative contains
 * at least one proof. ALL references include every parent, so any parent's
 * independent proof suffices; ANY references require a proof in every parent.
 * This never combines different meanings or synthesizes a cross-claim proof. */
export function coversReferenceScope(scope: PropositionScope, claims: readonly number[]): boolean {
  const supported = new Set(claims), nodes = new Map(scope.nodes.map(n => [n.claimNo, n]));
  if ([...supported].some(n => !nodes.has(n))) return false;
  const memo = new Map<number, boolean>();
  const visit = (no: number): boolean => {
    if (memo.has(no)) return memo.get(no)!;
    const node = nodes.get(no);
    if (!node || node.relation === "unresolved") return false;
    const answer = supported.has(no) || (!!node.refs.length && (node.relation === "any_of"
      ? node.refs.every(visit) : node.refs.some(visit)));
    memo.set(no, answer); return answer;
  };
  return visit(scope.selected);
}
