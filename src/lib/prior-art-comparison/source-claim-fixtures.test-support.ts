import {fictionalClauseSource} from "./source-clause-fixtures.test-support";
import {fixturePropositionWire} from "./proposition-fixtures.test-support";
import type {propositionSourceTransport} from "./proposition-extraction";
import {sourceReadingClaim,type SourceReadingClaim} from "./source-clause-coverage";
import {sourceIdentifiedQuoteDictionary,sourceQuoteDictionary,sourceIdentifiedFact,sourceDictionaryFact,resolveSourceOrderedQuote,sourceMatchedTasks,sourceDeclaredOrderedEvidence} from "./source-reading-tasks";
import {sourceCellRef} from "./source-citation-grid";
import {sourceClaimObligations} from "./source-claim-obligations";
type Transport=ReturnType<typeof propositionSourceTransport>;
export type FictionalClaimRequest={task:"extract_source_propositions";target:{sourceDigest:string;claimNo:number};sourceContext:Transport["sources"][number]};
/** Only hand-authored fictional fixtures enter this adapter. Never call it with
 * provider output: it does not authorize repairing historical answers. */
export function fictionalCoordinateClaim<F>(c:SourceReadingClaim,claim:{Q:unknown;facts:F[]}){
 const labels=sourceIdentifiedQuoteDictionary(c,claim.Q),dict=sourceQuoteDictionary(c,labels.quotes),all=c.clauses.map((_,i)=>i);
 const original=claim.Q as ({id:string}|string)[];
 const Q=labels.quotes.map((q,i)=>({id:typeof original[i]==="string"?(original[i] as string).split("|")[0]:(original[i] as {id:string}).id,K:sourceCellRef(c.grid,resolveSourceOrderedQuote(c,q,all))}));
 const obligations=sourceClaimObligations(c),bindings:Record<string,number>={};
 claim.facts.forEach((row,at)=>{
  const f=sourceDictionaryFact(c,sourceIdentifiedFact(row,labels),dict).fact,ids=sourceDeclaredOrderedEvidence(c,f);
  const action=f.m.k==="relation"?resolveSourceOrderedQuote(c,f.m.a,ids):null;
  for(const i of sourceMatchedTasks(obligations,f.m,ids,action,[]))bindings[`t${i}`]??=at;
 });
 if(Object.keys(bindings).length!==obligations.length)throw Error("fictional_fixture_has_uncovered_obligation");
 return {Q,facts:claim.facts,...bindings};
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
 answer[`c${c.claimNo}`]=fictionalCoordinateClaim(reading,answer[`c${c.claimNo}`]);
 return {v:24,sourceDigest:input.target.sourceDigest,claimNo:input.target.claimNo,answer};
}
