import type { Span } from "./propositions";
import { resolveSourceCellRef, sourceCitationGrid, type SourceCitationGrid } from "./source-citation-grid";

/** Punctuation partitions the unchanged text for a reading checklist only.
 * A clause can contain several meanings; coverage never proves those meanings. */
export function sourceReadingClauses(text:string):Span[] {
  const spans:Span[]=[];let start=0;
  for(let i=0;i<text.length;i++)if(/[、。;；\n]/u.test(text[i])){
    if(text.slice(start,i+1).trim())spans.push([start,i+1]);
    else if(spans.length)spans[spans.length-1][1]=i+1;
    else continue;
    start=i+1;
  }
  if(start<text.length){
    if(text.slice(start).trim())spans.push([start,text.length]);
    else if(spans.length)spans[spans.length-1][1]=text.length;
  }
  if(!spans.length||spans[0][0]!==0)throw new Error("comparison_source_coverage_invalid");
  return spans;
}
export type SourceReadingClaim={claimNo:number;grid:SourceCitationGrid;clauses:Span[]};
export const sourceReadingClaim=(claimNo:number,text:string):SourceReadingClaim=>({claimNo,grid:sourceCitationGrid(text),clauses:sourceReadingClauses(text)});
const invalid=()=>new Error("comparison_source_coverage_invalid");
export function sourceFactEvidence(claim:SourceReadingClaim,value:unknown):Span[] {
  if(!Array.isArray(value)||!value.length||value.length>12)throw invalid();
  const spans=value.map(ref=>resolveSourceCellRef(claim.grid,ref));
  if(new Set(spans.map(s=>s.join(":"))).size!==spans.length||
    spans.some(([a,b])=>!claim.clauses.some(([x,y])=>x===a&&y===b)||
      !/[^\p{P}\p{Z}\p{C}]/u.test(claim.grid.text.slice(a,b))))throw invalid();
  return spans;
}
export function assertEvidenceContains(spans:readonly Span[],[start,end]:Span) {
  let at=start;
  for(const[a,b]of [...spans].sort((x,y)=>x[0]-y[0])){
    if(a>at)break;if(b>at)at=b;if(at>=end)return;
  }
  throw invalid();
}
/** Validate the declared reading record; do not infer a predicate from words,
 * repair an omission, or mark unresolved remainder as semantically accepted. */
export function assertSourceClauseCoverage(claims:readonly SourceReadingClaim[],
  facts:ReadonlyMap<string,{claimNo:number;evidence:Span[]}>,value:unknown) {
  const clauses=claims.flatMap(c=>c.clauses.map(span=>({claimNo:c.claimNo,span})));
  if(!Array.isArray(value)||value.length!==clauses.length)throw invalid();
  const used=new Set<string>();
  for(const [i,row]of value.entries()){
    if(!Array.isArray(row)||!row.length||row.length>64||row.some(s=>typeof s!=="string")||new Set(row).size!==row.length)throw invalid();
    const clause=clauses[i];
    for(const address of row){
      if(address.startsWith("?")){
        if(!address.slice(1).trim()||address.length>401)throw invalid();
        continue;
      }
      const fact=facts.get(address);
      if(!fact||fact.claimNo!==clause.claimNo||!fact.evidence.some(([a,b])=>a===clause.span[0]&&b===clause.span[1]))throw invalid();
      used.add(address);
    }
  }
  if(used.size!==facts.size)throw invalid();
}
