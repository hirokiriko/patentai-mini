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
export const PROPOSITION_SOURCE_TEXT_GUIDE = "Join ALL ordered {id,text} parts per claim, repetitions included. IDs mark storage, not clauses; modes/guards/routes cross parts.";
export const PROPOSITION_LOCATOR_GUIDE = "Each source/target has its own locators table. A locator is an EXACT nonempty quote plus occurrence (0-based among ALL exact match starts, including overlaps). Source locators also name claimNo. Use only this full claim or target, preserving spaces and punctuation; no normalization, inferred text or character counting. Every output span field is a zero-based table index, not [start,end). Reuse the same index for the same location; no duplicate or unused locators. A source fact uses only locators in its claimNo. Input metadata coordinates still use UTF16 [start,end). Quote resolution does not prove meaning.";
export const PROPOSITION_SOURCE_TERM_GUIDE = `locatorVersion=11; source order=input. EACH c<claimNo> directly contains a nonempty array of own facts OR {quote,occurrence,reason} naming unsupported meaning. Never both. 'Not extracted' is no reason. Claims with required loops use an array of additional facts, possibly []. Canonical-only: quote the exact supplied set as already supplied; extract other own facts.
loop0,loop1,...: whole routes, fixed claimNo/frame ID, MODE subject, basis EXACT input basisParts. c<claimNo> facts have NO claimNo/basis fields: the key identifies the COMPLETE claim. Parent OR limits inheritance, not own facts; no parent merging/word borrowing.
EVERY {quote,occurrence} uses the COMPLETE claim, never a part. Count zero-based exact overlaps/embedded matches; select the correct context. Term fragments total<=80 chars. 冷房 inside 除湿冷房 is not independent 冷房.
{quote:null,occurrence:0}=whole claim for long operator/frame proof. operators:null=five nulls, not required proof. Other whole routes need frames; segments/sets/relations use null.`;
