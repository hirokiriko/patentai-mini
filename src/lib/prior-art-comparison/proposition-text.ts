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
export const PROPOSITION_SOURCE_TERM_GUIDE = `Readable names below use v13 spelling. sources=input order. cN=own facts OR unresolved {quote,before,after,edge,reason}; only required-loop claims allow []. Explain unsupported meaning, not 'not extracted'. Canonical-only: quote supplied set; extract other facts.
loopN=whole route with fixed claimNo/frame ID, MODE subject, input basisParts. cN has NO claimNo/basis: ALL claim parts are available. Parent OR limits inheritance, never own facts; no cross-claim borrowing.
Prefer {part,quote}: exact claim-local input ID and ONE exact occurrence within that part. Same-part repeats/cross-part quotes need context. Parts are not semantic boundaries. Each role independently selects its actual clause; no counting/normalization/fallback.
Context {quote,before,after,edge}: exact adjacent before/after (empty=none); edge none/start/end/both binds the full concatenation to claim edges. Require ONE full-claim match. Terms<=80 characters; retain complete condition words/negation inside operators.guard. Adjacent fragments may form a word; 冷房 inside 除湿冷房 is not independent 冷房.
{quote:null,before:"",after:"",edge:"both"}=whole-claim operator/frame proof. operators:null=five nulls, never missing required proof. Whole paths need frames; segments/sets/relations use null.`;
