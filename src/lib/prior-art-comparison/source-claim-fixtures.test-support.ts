import {fictionalClauseSource} from "./source-clause-fixtures.test-support";
import {fixturePropositionWire} from "./proposition-fixtures.test-support";
import type {propositionSourceTransport} from "./proposition-extraction";
type Transport=ReturnType<typeof propositionSourceTransport>;
export type FictionalClaimRequest={task:"extract_source_propositions";target:{sourceDigest:string;claimNo:number};sourceContext:Transport["sources"][number]};
/** Fictional SDK fixture only. It never processes or repairs real AI output. */
export function fictionalClaimSource(input:FictionalClaimRequest,prepare?:(raw:ReturnType<typeof fictionalClauseSource>)=>void){
 const transport={task:"extract_source_propositions",citationClauses:{version:7},sources:[input.sourceContext]} as unknown as Transport;
 const raw=fictionalClauseSource(transport);prepare?.(raw);
 const wire=fixturePropositionWire(raw),source=wire.s[0];
 const keys=["d",`c${input.target.claimNo}`,...input.sourceContext.recognizedLoopRoutes.filter(r=>r.claimNo===input.target.claimNo).map(r=>`loop${r.id}`)];
 return {v:23,sourceDigest:input.target.sourceDigest,claimNo:input.target.claimNo,answer:Object.fromEntries(keys.map(k=>[k,source[k]]))};
}
