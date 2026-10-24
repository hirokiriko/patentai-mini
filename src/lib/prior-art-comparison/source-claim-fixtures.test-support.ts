import {fictionalClauseSource} from "./source-clause-fixtures.test-support";
import {fixturePropositionWire} from "./proposition-fixtures.test-support";
import type {propositionSourceTransport} from "./proposition-extraction";
import {sourceReadingClaim,type SourceReadingClaim} from "./source-clause-coverage";
import {sourceIdentifiedQuoteDictionary,sourceQuoteDictionary,sourceIdentifiedFact,sourceDictionaryFact,resolveSourceOrderedQuote,sourceMatchedTasks,sourceDeclaredOrderedEvidence} from "./source-reading-tasks";
import {sourceClaimObligations} from "./source-claim-obligations";
type Transport=ReturnType<typeof propositionSourceTransport>;
export type FictionalClaimRequest={task:"extract_source_propositions";target:{sourceDigest:string;claimNo:number};sourceContext:Transport["sources"][number]};
/** Only hand-authored fictional fixtures enter this adapter. Never call it with
 * provider output: it does not authorize repairing historical answers. */
export function fictionalQuotationClaim<F>(c:SourceReadingClaim,claim:{Q:unknown;facts:F[]}){
 const labels=sourceIdentifiedQuoteDictionary(c,claim.Q),dict=sourceQuoteDictionary(c,labels.quotes),all=c.clauses.map((_,i)=>i);
 const original=claim.Q as ({id:string}|string)[];
 const Q=labels.quotes.map((q,i)=>{
  const [start,end]=resolveSourceOrderedQuote(c,q,all);
  const first=c.clauses.findIndex(([a,b])=>a<=start&&start<b),last=c.clauses.findIndex(([a,b])=>a<end&&end<=b);
  if(first<0||last<0)throw Error("fictional_fixture_missing_span_clause");
  const S=[first,Array.from(c.grid.text.slice(c.clauses[first][0],start)).length,last,Array.from(c.grid.text.slice(c.clauses[last][0],end)).length];
  return {id:typeof original[i]==="string"?(original[i] as string).split("|")[0]:(original[i] as {id:string}).id,S};
 });
 const obligations=sourceClaimObligations(c),bindings:Record<string,number>={};
 claim.facts.forEach((row,at)=>{
  const f=sourceDictionaryFact(c,sourceIdentifiedFact(row,labels),dict).fact,ids=sourceDeclaredOrderedEvidence(c,f);
  const action=f.m.k==="relation"?resolveSourceOrderedQuote(c,f.m.a,ids):null;
  for(const i of sourceMatchedTasks(obligations,f.m,ids,action,[]))bindings[`t${i}`]??=at;
 });
 if(Object.keys(bindings).length!==obligations.length)throw Error("fictional_fixture_has_uncovered_obligation");
 const grouped:Record<string,unknown>={};const order:number[]=[];
 c.clauses.forEach((_,R)=>{grouped[`f${R}`]=claim.facts.flatMap((row,i)=>{const value=row as F&{R:number};if(value.R!==R)return[];order.push(i);const {R:_anchor,...fact}=value;void _anchor;return[fact];});});
 const T=obligations.map((_,i)=>order.indexOf(bindings[`t${i}`]));
 return {...grouped,T,Q} as Record<string,unknown>&{T:number[];Q:typeof Q};
}
/** Fictional SDK fixture only. It never processes or repairs real AI output. */
export function fictionalClaimSource(input:FictionalClaimRequest,prepare?:(raw:ReturnType<typeof fictionalClauseSource>)=>void){
 const transport={task:"extract_source_propositions",citationClauses:{version:7},sources:[input.sourceContext]} as unknown as Transport;
 const raw=fictionalClauseSource(transport);prepare?.(raw);
 const wire=fixturePropositionWire(raw),source=wire.s[0];
 const keys=["d",`c${input.target.claimNo}`,...input.sourceContext.recognizedLoopRoutes.filter(r=>r.claimNo===input.target.claimNo).map(r=>`loop${r.id}`)];
 const c=input.sourceContext.source.claims.find(c=>c.claimNo===input.target.claimNo)!;
 const reading=sourceReadingClaim(c.claimNo,c.clauses.map(([,text])=>text).join(""));
 const answer=Object.fromEntries(keys.map(k=>[k,source[k]]));
 answer[`c${c.claimNo}`]=fictionalQuotationClaim(reading,answer[`c${c.claimNo}`]);
 return {v:28,sourceDigest:input.target.sourceDigest,claimNo:input.target.claimNo,answer};
}
