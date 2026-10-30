import { managedClaimReferences } from "../koho-import/managed-claim-source";
import { ManagedClaimsError, validateManagedClaims, type ManagedClaimSet } from "../patent-watch/managed-claims";
import { ComparisonError } from "./source";

export type ReferenceRelation = "none" | "single" | "any_of" | "all_of" | "unresolved";
export type ReferenceClause = Readonly<{
  /** Exact original-text slice; offsets are JavaScript UTF-16 code units. */
  text: string;
  start: number;
  end: number;
  refs: readonly number[];
}>;
type UnresolvedReason = "reference_invalid" | "references_mismatch" | "multiple_clauses" | "mixed_relation" | "relation_unspecified";
export type ClaimReferenceLogic = Readonly<{
  claimNo: number;
  directRefs: readonly number[];
  referenceClauses: readonly ReferenceClause[];
  relation: ReferenceRelation;
  unresolvedReasons: readonly UnresolvedReason[];
}>;
export type ReferenceScope = Readonly<{
  claimNo: number;
  /** All reachable claim IDs. Their complete original text remains in the source input. */
  closureClaimNos: readonly number[];
  /** Claim IDs common to every reference branch, including this claim. This does
   * not mean that technical conditions in other claim texts are optional. */
  guaranteedClaimNos: readonly number[] | null;
  /** Branch-dependent claim IDs, not a classification of their technical conditions. */
  conditionalClaimNos: readonly number[] | null;
  /** No guaranteed/conditional inference is made for an unresolved scope. */
  unknownClaimNos: readonly number[];
  fullyResolved: boolean;
}>;
export type ReferenceLogicGuide = Readonly<{
  publicationNumber: string;
  version: string;
  selectedClaimNos: readonly number[];
  claims: readonly ClaimReferenceLogic[];
  scopes: readonly ReferenceScope[];
}>;

const sorted = (values: Iterable<number>): readonly number[] => Object.freeze([...new Set(values)].sort((a, b) => a - b));
const same = (left: readonly number[], right: readonly number[]) => left.length === right.length && left.every((n, i) => n === right[i]);
// These replacements preserve UTF-16 length, so match offsets still refer to the original.
const normalize = (text: string) => text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/，/g, ",");
const conjunction = "(?:及び|および|又は|または|若しくは|もしくは)";
const separator = `(?:から|乃至|ないし|〜|～|－|-|[、,]\\s*${conjunction}\\s*[、,]?|、|,|${conjunction})`;
const selection = "(?:の(?:うち(?:の)?|内|少なくとも))?(?:の)?(?:いずれか|何れか|すべて|全て)(?:\\s*[1一](?:項|つ)(?:の請求項)?)?";
const anyOf = /いずれか|何れか|又は|または|若しくは|もしくは/;
const allOf = /及び|および|全て|すべて/;

function claimLogic(claim: ManagedClaimSet["claims"][number]): ClaimReferenceLogic {
  const text = normalize(claim.text), clauses: ReferenceClause[] = [];
  const expression = new RegExp(`請求項\\s*([0-9]+(?:\\s*${separator}\\s*(?:請求項\\s*)?[0-9]+)*)(?:\\s*まで)?(?:\\s*(${selection}))?`, "g");
  const reasons = new Set<UnresolvedReason>();
  for (const match of text.matchAll(expression)) {
    let refs: readonly number[] = [];
    try { refs = sorted(managedClaimReferences(`請求項${match[1]}に記載。`)); }
    catch { reasons.add("reference_invalid"); }
    const start = match.index, end = start + match[0].length;
    // A selector prefix is not the whole selector: "いずれか2項" and
    // "いずれか1項以上" must not become an ordinary one-branch alternative.
    // Accept only a completed supported selector followed by a reference tail.
    if (match[2] && (/少なくとも/.test(match[2]) || /少なくとも\s*(?:前記\s*)?$/.test(text.slice(0, start)) ||
        !/^\s*(?:に(?:記載|係る|おいて)|記載(?:の|された|される|する|[。．]|$)|[。．]|$)/.test(text.slice(end)))) {
      reasons.add("reference_invalid");
    }
    clauses.push(Object.freeze({ text: claim.text.slice(start, end), start, end, refs }));
  }
  // An omitted second "請求項" is not a complete numbered reference phrase.
  // The shared parser may accept its first prefix; do not turn that into a
  // resolved single edge. Ordinary counts such as "2つ" do not match this tail.
  let outsideClauses = text;
  for (const clause of [...clauses].reverse()) {
    outsideClauses = outsideClauses.slice(0, clause.start) + " ".repeat(clause.end - clause.start) + outsideClauses.slice(clause.end);
  }
  if (clauses.length && /(?:及び|および|又は|または|若しくは|もしくは|並びに|と|[、,])\s*(?:第\s*)?[0-9]+\s*(?:項\s*)?(?:に(?:記載|係る|おいて)|記載|の記載|を引用)/.test(outsideClauses)) {
    reasons.add("reference_invalid");
  }
  // Validate the entire original reference grammar, not merely a regex prefix.
  // Only the explicit ALL synonym inside a captured reference clause is adapted
  // for the shared parser; neither the source nor the shared parser is changed.
  let forValidation = claim.text;
  for (const clause of [...clauses].reverse()) {
    forValidation = forValidation.slice(0, clause.start) + clause.text.replace(/全て/g, "すべて") + forValidation.slice(clause.end);
  }
  const directRefs = sorted(claim.dependsOn), clauseRefs = sorted(clauses.flatMap(c => c.refs));
  try {
    if (!same(sorted(managedClaimReferences(forValidation)), directRefs)) reasons.add("references_mismatch");
  } catch { reasons.add("reference_invalid"); }
  if (!same(clauseRefs, directRefs)) reasons.add("references_mismatch");
  if (clauses.length > 1) reasons.add("multiple_clauses");
  let relation: ReferenceRelation = "unresolved";
  if (!reasons.size) {
    if (!directRefs.length) relation = "none";
    else {
      const phrase = clauses[0]?.text ?? "", hasAny = anyOf.test(phrase), hasAll = allOf.test(phrase);
      if (hasAny && hasAll) reasons.add("mixed_relation");
      else if (directRefs.length === 1) relation = "single";
      else if (hasAny) relation = "any_of";
      else if (hasAll) relation = "all_of";
      else reasons.add("relation_unspecified");
    }
  }
  return Object.freeze({ claimNo: claim.claimNo, directRefs, referenceClauses: Object.freeze(clauses), relation,
    unresolvedReasons: Object.freeze([...reasons]) });
}

/** Mechanical reference guidance only. It retains every reachable claim ID and
 * exact reference phrase; it never rewrites, summarizes, or drops source text. */
export function buildReferenceLogicGuide(source: ManagedClaimSet, selectedClaimNos: readonly number[]): ReferenceLogicGuide {
  validateManagedClaims(source);
  if (!Array.isArray(selectedClaimNos) || !selectedClaimNos.length || new Set(selectedClaimNos).size !== selectedClaimNos.length ||
      selectedClaimNos.some(n => !Number.isSafeInteger(n) || n <= 0)) throw new ManagedClaimsError("claims_invalid");
  const byNo = new Map(source.claims.map(c => [c.claimNo, c]));
  const closures = selectedClaimNos.map(claimNo => {
    const included = new Set<number>(), pending = [claimNo];
    while (pending.length) {
      const no = pending.pop()!;
      if (included.has(no)) continue;
      const claim = byNo.get(no);
      if (!claim) throw new ManagedClaimsError("reference_missing");
      included.add(no); pending.push(...claim.dependsOn);
    }
    return { claimNo, closureClaimNos: sorted(included) };
  });
  const claims = sorted(closures.flatMap(c => c.closureClaimNos)).map(no => claimLogic(byNo.get(no)!));
  const logic = new Map(claims.map(c => [c.claimNo, c]));
  const guaranteed = new Map<number, Set<number> | null>();
  // Iterative postorder also handles long dependency chains without recursion.
  for (const root of selectedClaimNos) {
    const pending = [{ no: root, exit: false }];
    while (pending.length) {
      const { no, exit } = pending.pop()!;
      if (guaranteed.has(no)) continue;
      const claim = logic.get(no)!;
      if (!exit) {
        pending.push({ no, exit: true });
        for (const ref of claim.directRefs) pending.push({ no: ref, exit: false });
        continue;
      }
      const parents = claim.directRefs.map(ref => guaranteed.get(ref));
      if (claim.relation === "unresolved" || parents.some(p => !p)) { guaranteed.set(no, null); continue; }
      const complete = parents as Set<number>[];
      const inherited = claim.relation === "any_of"
        ? [...complete[0]].filter(n => complete.every(p => p.has(n)))
        : complete.flatMap(p => [...p]);
      guaranteed.set(no, new Set([no, ...inherited]));
    }
  }
  const scopes = closures.map(({ claimNo, closureClaimNos }): ReferenceScope => {
    const common = guaranteed.get(claimNo)!;
    return Object.freeze({ claimNo, closureClaimNos, fullyResolved: common !== null,
      guaranteedClaimNos: common === null ? null : sorted(common),
      conditionalClaimNos: common === null ? null : sorted(closureClaimNos.filter(n => !common.has(n))),
      unknownClaimNos: common === null ? closureClaimNos : Object.freeze([]) });
  });
  return Object.freeze({ publicationNumber: source.publicationNumber, version: source.version,
    selectedClaimNos: Object.freeze([...selectedClaimNos]), claims: Object.freeze(claims), scopes: Object.freeze(scopes) });
}

/** Send edges and selected-scope claim-ID sets once alongside the unchanged
 * source. Independent nodes already have dependsOn:[] in that source; omit
 * repeated identities, empty diagnostics, and duplicate closure arrays. */
export function referenceLogicInput(source: ManagedClaimSet, selectedClaimNos: readonly number[]) {
  const guide = buildReferenceLogicGuide(source, selectedClaimNos);
  if (guide.scopes.some(scope => !scope.fullyResolved)) throw new ComparisonError("source_review_required");
  return {
    relations: guide.claims.filter(claim => claim.directRefs.length).map(claim => ({
      claimNo: claim.claimNo, directRefs: claim.directRefs, referenceClauses: claim.referenceClauses, relation: claim.relation,
    })),
    scopes: guide.scopes.map(scope => ({ claimNo: scope.claimNo,
      guaranteedClaimNos: scope.guaranteedClaimNos!, conditionalClaimNos: scope.conditionalClaimNos! })),
  };
}
