import type { Span } from "./propositions";

/** Positions of the unchanged, ordered claim parts. IDs are local to one
 * claim, not dictionary IDs, so repeated text never loses its occurrence. */
export function sourceCitationParts(parts: readonly string[]): Span[] {
  let cursor=0;
  return parts.map(text=>{const start=cursor;cursor+=text.length;return [start,cursor];});
}

export function sourceCitationRange(parts:readonly Span[],first:number,last:number):Span {
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||first<0||last<first||last>=parts.length)
    throw new Error("comparison_locator_invalid");
  return [parts[first][0],parts[last][1]];
}

export function sourceCitationPartIds(parts:readonly Span[],span:Span):[number,number] {
  const first=parts.findIndex(([a,b])=>span[0]>=a&&span[0]<b),last=parts.findIndex(([a,b])=>span[1]>a&&span[1]<=b);
  if(first<0||last<first||span[1]<=span[0])throw new Error("comparison_locator_invalid");
  return [first,last];
}

/** Encode an existing evidence span, without selecting a semantic role or
 * searching another claim. Repeated/overlapping matches retain their exact
 * occurrence within the selected parts, including a return to the same noun. */
export function sourceCitationLocator(text:string,parts:readonly Span[],span:Span) {
  const [start,end]=span;
  const splits=(at:number)=>/[\uD800-\uDBFF]/u.test(text[at-1]??"")&&/[\uDC00-\uDFFF]/u.test(text[at]??"");
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>text.length||splits(start)||splits(end))
    throw new Error("comparison_locator_invalid");
  const [firstPart,lastPart]=sourceCitationPartIds(parts,span),[a,b]=sourceCitationRange(parts,firstPart,lastPart);
  const selected=text.slice(a,b),quote=text.slice(start,end),relative=start-a;
  let position=-1,occurrence=-1;
  do {position=selected.indexOf(quote,position+1);occurrence++;}while(position>=0&&position<relative);
  if(position!==relative)throw new Error("comparison_locator_invalid");
  return {firstPart,lastPart,quote,occurrence};
}
