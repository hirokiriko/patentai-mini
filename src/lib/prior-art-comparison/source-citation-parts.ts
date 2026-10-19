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
