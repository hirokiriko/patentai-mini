import type {SourceReadingClaim} from "./source-clause-coverage";
import {SOURCE_CAPACITY} from "./source-capacity";
import {sourceCellRef} from "./source-citation-grid";
import {decodeClaimCoordinateQuotes} from "./source-claim-coordinates";
const invalid=()=>new Error("comparison_source_clause_quotation_invalid");
/** Explicit clause selects a start occurrence, never a repaired quote/location.
 * Only exact original text can become the established internal span locator. */
export function decodeClaimClauseQuotes(c:SourceReadingClaim,value:unknown):unknown[]{
 if(!Array.isArray(value)||value.length>SOURCE_CAPACITY.quotes||Buffer.byteLength(JSON.stringify(value),'utf8')>SOURCE_CAPACITY.wireBytes)throw invalid();
 const ids=new Set<string>(),spans=new Set<string>();
 const encoded=value.map(entry=>{
  if(!entry||typeof entry!=="object"||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=="clause,id,quote")throw invalid();
  const {id,quote,clause}=entry as {id:unknown;quote:unknown;clause:unknown};
  if(typeof id!=="string"||!/^q[0-9]{1,4}$/u.test(id)||ids.has(id)||typeof quote!=="string"||!quote.length||quote.length>12000||!Number.isSafeInteger(clause)||Number(clause)<0||!c.clauses[Number(clause)])throw invalid();
  const [a,b]=c.clauses[Number(clause)],matches:number[]=[];
  for(let start=c.grid.text.indexOf(quote);start>=0;start=c.grid.text.indexOf(quote,start+1))if(a<=start&&start<b)matches.push(start);
  if(matches.length!==1)throw invalid();
  const span:[number,number]=[matches[0],matches[0]+quote.length],key=span.join(':');
  if(spans.has(key))throw invalid();
  const covered=c.clauses.filter(([x,y])=>x<span[1]&&y>span[0]);if(!covered.length||covered.length>12)throw invalid();
  const K=sourceCellRef(c.grid,span);ids.add(id);spans.add(key);return{id,K};
 });
 return decodeClaimCoordinateQuotes(c,encoded);
}
