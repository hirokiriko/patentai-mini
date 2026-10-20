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
export const PROPOSITION_SOURCE_TERM_GUIDE = `v=8. Keys: ss/sd=sources/digest,cc/cn=claims/number,rr/ff=requiredLoops/facts,bb=firstPart(fp)..lastPart(lp),ll=quote(q)/occurrence(o),mm=meaning,op=operators,rf=routeFrame. Roles: su=subject,cx=context,gr/gc=guard relation/conditions,po=polarity,ki=kind,se/ex=selection/extent,me=members,or/de=origin/destination,vi/by=via/bypass,re=relation,pr/ob=predicate/objects,gu=guard,en/et/rt=entry/exit/route,ec/ct=exclusions/controls.
Choose meaning, then ONE bb covering all evidence, including later modes/guards. Create ll ONLY for mm/op/explicit rf references; bb retains supporting prose. q matches exactly inside bb; o counts starts from 0, including embedded/overlapping matches. A suffix inside another mode is not its declaration. q:null,o:0 selects all bb. Reuse locations. References are fact-local ll indexes, not part IDs. Terms concatenate quotes, max80 characters. No borrowed indexes or widened bb.
rr follows this claim's recognizedLoopRoutes order: rf=inventory id, bb contains every basisPart, mm independently states the full route with inventory MODE subject. Catalog frames need no extra ll. Other whole routes use explicit rf.`;
