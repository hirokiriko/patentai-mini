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
export const PROPOSITION_SOURCE_TERM_GUIDE = `locatorVersion=12; sources=input order. Each cN: own facts OR {quote,before,after,edge,reason}, never both. Only required-loop claims may use []. Explain unsupported meaning; not 'not extracted'. Canonical-only: quote supplied set; extract other facts.
loopN: whole route, fixed claimNo/frame ID, MODE subject, exact input basisParts. cN has NO claimNo/basis: it names the COMPLETE claim. Parent OR limits inheritance, not own facts; no cross-claim borrowing.
{quote,before,after,edge}: before/after=exact adjacent text (""=none). edge=none/start/end/both binds their concatenation WITH quote to claim edges. Apply edge, require ONE exact match in the complete claim. No counting/normalization/fallback. Use the actual component/condition clause. Terms<=80 chars; keep full condition words/negation, inside operators.guard. Adjacent fragments may form a word. 冷房 within 除湿冷房 is not independent 冷房.
{quote:null,before:"",after:"",edge:"both"}=whole-claim operator/frame proof. operators:null=five nulls, not required proof. Other whole routes need frames; segments/sets/relations use null.`;
