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
export const PROPOSITION_SOURCE_TEXT_GUIDE = "Concatenate each claim's ordered {id,text} parts for its COMPLETE original, repetitions included. IDs mark storage, not clauses: modes/conditions/routes cross parts. Never infer IDs from sentences.";
export const PROPOSITION_LOCATOR_GUIDE = "Each source/target has its own locators table. A locator is an EXACT nonempty quote plus occurrence (0-based among ALL exact match starts, including overlaps). Source locators also name claimNo. Use only this full claim or target, preserving spaces and punctuation; no normalization, inferred text or character counting. Every output span field is a zero-based table index, not [start,end). Reuse the same index for the same location; no duplicate or unused locators. A source fact uses only locators in its claimNo. Input metadata coordinates still use UTF16 [start,end). Quote resolution does not prove meaning.";
export const PROPOSITION_SOURCE_TERM_GUIDE = `locatorVersion=9; ordered sources/coverage/facts. Each fact: claimNo, one basis={firstPart,lastPart}. Quotes MUST be {quote,occurrence}, never strings/indexes. Term arrays join exact fragments (total<=80 chars).
Select basis covering ALL roles, mode names and full guards. Then count zero-based matches, including embedded/overlaps; another mode's suffix is not its declaration. Copy 前記/spaces/punctuation exactly. No repair/range expansion/borrowed positions. Operator/frame {quote:null,occurrence:0}=whole basis; operators:null=five nulls, never required proof.
Each claim's recognizedLoopRoutes come first in catalog order: routeFrame=id, MODE subject, independent full route, all basisParts. Other whole routes need explicit frame; segments/sets/relations use null. coverage.unresolved=null with facts; else exact claim quote+substantive reason. Coverage is no fact/verdict; originals stay available.`;
