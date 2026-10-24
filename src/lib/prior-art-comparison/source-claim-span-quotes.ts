import type {SourceReadingClaim} from "./source-clause-coverage";
import {SOURCE_CAPACITY} from "./source-capacity";
import {sourceCellRef} from "./source-citation-grid";
import {decodeClaimCoordinateQuotes} from "./source-claim-coordinates";
const invalid=()=>new Error("comparison_source_clause_span_invalid");
/** Select original Unicode scalar boundaries only. No generated text, search,
 * normalization, nearest match or completion can supply a quotation. */
export function decodeClaimSpanQuotes(c:SourceReadingClaim,value:unknown):unknown[]{
 if(!Array.isArray(value)||value.length>SOURCE_CAPACITY.quotes||Buffer.byteLength(JSON.stringify(value),'utf8')>SOURCE_CAPACITY.wireBytes)throw invalid();
 const ids=new Set<string>(),spans=new Set<string>();
 const encoded=value.map(entry=>{
  if(!entry||typeof entry!=="object"||Array.isArray(entry)||Object.keys(entry).sort().join(',')!=="S,id")throw invalid();
  const {id,S}=entry as {id:unknown;S:unknown};
  if(typeof id!=="string"||!/^q[0-9]{1,4}$/u.test(id)||ids.has(id)||!Array.isArray(S)||S.length!==4||S.some(n=>!Number.isSafeInteger(n)||n<0))throw invalid();
  const [first,start,last,end]=S as number[];
  if(!c.clauses[first]||!c.clauses[last]||last<first||last-first>=12)throw invalid();
  const a=c.clauses[first],b=c.clauses[last],left=Array.from(c.grid.text.slice(...a)),right=Array.from(c.grid.text.slice(...b));
  if(start>=left.length||end<1||end>right.length||first===last&&end<=start)throw invalid();
  const span:[number,number]=[a[0]+left.slice(0,start).join("").length,b[0]+right.slice(0,end).join("").length],key=span.join(':');
  if(span[1]<=span[0]||span[1]-span[0]>12000||spans.has(key))throw invalid();
  ids.add(id);spans.add(key);return{id,K:sourceCellRef(c.grid,span)};
 });
 return decodeClaimCoordinateQuotes(c,encoded);
}
