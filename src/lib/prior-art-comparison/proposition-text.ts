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
export const PROPOSITION_LOCATOR_GUIDE = "Each source/target has its own locators table. A locator is an EXACT nonempty quote plus occurrence (0-based among ALL exact match starts, including overlaps). Source locators also name claimNo. Use only this full claim or target, preserving spaces and punctuation; no normalization, inferred text or character counting. Every output span field is a zero-based table index, not [start,end). Reuse the same index for the same location; no duplicate or unused locators. A source fact uses only locators in its claimNo. Input metadata coordinates still use UTF16 [start,end). Quote resolution does not prove meaning.";
export const PROPOSITION_SOURCE_TERM_GUIDE = "Return locatorVersion=2. In each source meaning, EVERY term is an array of locator indices: concatenate those exact quotes to obtain that term. There is no separate bindings output. Use a short literal term quote, not the surrounding clause. For fictional text '装置は青色弁を備える。', if locators 0/1/2 quote the whole sentence/'装置'/'青色弁', a has fact uses basis:[0], subject:[1], objects:[[2]]; subject:[0] would mean the entire sentence and is wrong. Every term quote must lie inside this fact's basis. A subject not printed in that basis is null, never an invented device label. Compose a shared printed suffix with multiple indices only when their concatenation is the exact intended term. Repeated terms may share one index, but a quote at another occurrence outside the basis cannot be reused. Count occurrences in this single full claim; occurrences inside longer words count too. Whole-route entry and exit evidence remain separate even when both name the same component.";
