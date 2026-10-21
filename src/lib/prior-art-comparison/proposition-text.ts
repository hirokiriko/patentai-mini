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
export const PROPOSITION_SOURCE_TERM_GUIDE = `locatorVersion=10; sources in input order. coverage is the required c<claimNo> map for ALL input claims, not just selected ones. Value=null with any fact; otherwise {quote,occurrence,reason} explains unresolved original content.
Each source's required loop0,loop1,... fields contain independent whole-route facts: fixed claimNo/routeFrame ID, MODE subject, all basisParts. facts contains other facts in claim order. Never replace ancestors or loops with selected claims.
For each fact FIRST choose one basis={firstPart,lastPart} containing ALL roles, mode names, guards and frame evidence. THEN concatenate only those parts, copy exact quote strings from that substring and recount every occurrence from zero there. A role outside this substring means the proposed basis is wrong; choose its complete range before answering. Never borrow a full-claim count or invent a quote. Quote objects={quote,occurrence}; term arrays join exact fragments (total<=80 chars). Count embedded/overlapping matches too, but select the intended declaration: 冷房モード inside 除湿冷房モード is not the separate 冷房モード.
For long operator/frame proof prefer {quote:null,occurrence:0}, explicitly selecting the complete basis, rather than retyping or shortening it. operators:null means five nulls, never required proof. No invented/borrowed words or range expansion. Other whole routes need explicit frames; segments/sets/relations use null.`;
