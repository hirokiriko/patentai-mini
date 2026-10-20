/** Exact string interning, never a summary or run-length elision. Every original
 * occurrence remains in its claim's ordered list. UTF-16 offsets are cumulative
 * lengths of the referenced strings, including repeated occurrences. */
export function propositionTextTable() {
  const textParts: string[] = [], indices = new Map<string,number>();
  return { textParts, add(text: string): number {
    let index = indices.get(text);
    if (index === undefined) { index = textParts.length; indices.set(text,index); textParts.push(text); }
    return index;
  } };
}
export const PROPOSITION_TEXT_GUIDE = "textParts is a lossless dictionary of exact original segments, NOT summaries. Each claim's parts lists EVERY occurrence in its original order, including repetitions; concatenate textParts[index] to recover the COMPLETE claim. UTF16 offsets are cumulative string lengths. For target originals, segments=[originalOrdinal,textPartIndex]. All occurrences and conditions remain material.";
export const PROPOSITION_SOURCE_TEXT_GUIDE = "Each claim's ordered {id,text} parts preserve its COMPLETE exact original, including repetitions. Concatenate their text. IDs are claim-local storage boundaries, not clauses: modes/conditions/routes may cross parts. Never infer IDs from sentence order.";
export const PROPOSITION_LOCATOR_GUIDE = "Each source/target has its own locators table. A locator is an EXACT nonempty quote plus occurrence (0-based among ALL exact match starts, including overlaps). Source locators also name claimNo. Use only this full claim or target, preserving spaces and punctuation; no normalization, inferred text or character counting. Every output span field is a zero-based table index, not [start,end). Reuse the same index for the same location; no duplicate or unused locators. A source fact uses only locators in its claimNo. Input metadata coordinates still use UTF16 [start,end). Quote resolution does not prove meaning.";
export const PROPOSITION_SOURCE_TERM_GUIDE = `Return locatorVersion=9, sources in order, coverage for every claimNo in order, and flat facts in claim order. Each fact has claimNo and one basis={firstPart,lastPart}. Terms are arrays of exact quotes concatenated to at most 80 characters. Use a string ONLY for exactly one match in basis; otherwise {quote,occurrence}. No locator table.
Choose meaning and one basis covering ALL evidence, later mode names and full guards. Occurrence is zero-based among exact starts including embedded/overlapping matches. A suffix in another mode is not its declaration. Never normalize quotes, widen basis or borrow another fact's position. Operators/frame may also use {quote:null,occurrence:0} for exactly that entire basis.
For each claim, output its recognizedLoopRoutes first in catalog order: routeFrame=inventory id and independent meaning with the inventory MODE subject, complete route and all basisParts. Other facts use explicit frame or null. With any fact, coverage.unresolved=null. Without facts, provide an exact quote from the full claim and a substantive unresolved reason. This audit record supplies no fact or quality verdict; originals remain available.`;
