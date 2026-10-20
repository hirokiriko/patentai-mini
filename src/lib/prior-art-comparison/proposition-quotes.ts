import type { Span } from "./propositions";

/** Exact matching only, including overlapping starts. No normalization,
 * nearest match, alternate claim or implicit occurrence is permitted. */
export function resolvePropositionQuote(text:string, quote:string, occurrence:number):Span {
  const invalid=()=>new Error("comparison_locator_invalid");
  if (!quote.length || !Number.isSafeInteger(occurrence) || occurrence < 0) throw invalid();
  let start=-1;
  for(let i=0;i<=occurrence;i++){
    start=text.indexOf(quote,start+1);
    if(start<0)throw invalid();
  }
  const end=start+quote.length;
  const splits=(at:number)=>/[\uD800-\uDBFF]/u.test(text[at-1]??"")&&/[\uDC00-\uDFFF]/u.test(text[at]??"");
  if(splits(start)||splits(end)||text.slice(start,end)!==quote)throw invalid();
  return [start,end];
}
