/** Lossless lexical hints, never an interpretation of draft inheritance.
 * A range, slash or "through" identifies references without asserting AND/OR. */
export function reviewReferenceMentions(text: string) {
  const number = "[0-9０-９一二三四五六七八九十百千]+";
  const pattern = new RegExp(`請求項[\\t ]*${number}(?:[\\t ]*(?:[-－〜～~／/・、]|乃至|から)[\\t ]*(?:請求項[\\t ]*)?${number})*(?:まで)?`, "gu");
  return [...text.matchAll(pattern)].map(match => ({ start: match.index, end: match.index + match[0].length }));
}
export type ReferenceRelationCheck = { start: number; relation: "unspecified" | "all" | "any" | "unresolved";
  operatorBasis: { start: number; quote: string } | null };
export const REFERENCE_ALL_WORDS = ["全て", "すべて", "全部", "全項", "各項", "各々", "いずれも", "何れも", "両方", "双方", "同時に", "及び", "かつ", "且つ"] as const;
export const REFERENCE_ANY_WORDS = ["いずれか", "何れか", "少なくとも一つ", "少なくとも1つ", "少なくとも１つ", "又は", "または", "若しくは", "もしくは"] as const;

/** Literal proof only: attachment and truth still require semantic review.
 * An unspecified reference never automatically makes a unit consistent. */
export function validateReferenceRelations(text: string, unit: { start: number; end: number }, checks: readonly ReferenceRelationCheck[], uncertain: boolean) {
  const mentions = new Map(reviewReferenceMentions(text).filter(m => m.start >= unit.start && m.end <= unit.end).map(m => [m.start, m]));
  for (const check of checks) {
    if (!mentions.delete(check.start)) throw Error("reference_relation_coverage");
    if (check.relation === "unresolved" && !uncertain) throw Error("reference_relation_unresolved");
    if (check.relation === "unspecified" || check.relation === "unresolved") {
      if (check.operatorBasis !== null) throw Error("reference_relation_basis");
      continue;
    }
    const basis = check.operatorBasis;
    const words: readonly string[] = check.relation === "all" ? REFERENCE_ALL_WORDS : REFERENCE_ANY_WORDS;
    if (!basis || !words.includes(basis.quote) || basis.start < unit.start || basis.start + basis.quote.length > unit.end ||
      text.slice(basis.start, basis.start + basis.quote.length) !== basis.quote ||
      reviewReferenceMentions(text).some(m => basis.start < m.end && basis.start + basis.quote.length > m.start)) throw Error("reference_relation_basis");
  }
  if (mentions.size) throw Error("reference_relation_coverage");
}
