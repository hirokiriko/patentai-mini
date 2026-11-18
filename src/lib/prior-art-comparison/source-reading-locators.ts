import type { SourceExtraction } from "./proposition-extraction";
import type { Span } from "./propositions";

/** Internal identity-bound citations, never model meanings or acceptance proof.
 * Raw answers and the persisted witness keep their existing formats. */
export type SourceActionLocators = { sourceDigest: string; facts: {
  claimNo: number; factDigest: string; action: Span | null;
}[] }[];
export type SourceReadingWithLocators = { extraction: SourceExtraction; locators: SourceActionLocators };

export type FactLocators = { id: string; action: Span | null; quotes: Span[] };
/** Coordinates are claim-local, as declared by the same ID in facts.rows.
 * This dictionary contains no semantic labels or proposed target answers. */
export function compactFactLocators(facts:readonly FactLocators[]){
  const positions:Span[]=[],seen=new Map<string,number>();
  const at=(span:Span)=>{const key=JSON.stringify(span),prior=seen.get(key);if(prior!==undefined)return prior;
    const index=positions.length;positions.push([...span]);seen.set(key,index);return index;};
  return {version:1 as const,positions,rows:facts.map(f=>[f.id,f.action===null?null:at(f.action),
    [...new Set(f.quotes.map(at))]] as const)};
}
