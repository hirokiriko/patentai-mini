import {fictionalClauseSource} from "./source-clause-fixtures.test-support";
import {fixturePropositionWire} from "./proposition-fixtures.test-support";
import type {propositionSourceTransport} from "./proposition-extraction";
import {sourceReadingClaim,type SourceReadingClaim} from "./source-clause-coverage";
import {sourceIdentifiedQuoteDictionary,sourceQuoteDictionary,sourceIdentifiedFact,sourceDictionaryFact,resolveSourceOrderedQuote,sourceMatchedTasks,sourceDeclaredOrderedEvidence} from "./source-reading-tasks";
import {sourceClaimObligations} from "./source-claim-obligations";
const fixtureScopes=new WeakMap<object,unknown[]>();
export const fictionalScopesFor=(claim:object)=>fixtureScopes.get(claim)??[];
type Transport=ReturnType<typeof propositionSourceTransport>;
export type FictionalClaimRequest={task:"extract_source_propositions";target:{sourceDigest:string;claimNo:number};sourceContext:Transport["sources"][number]};
/** Only hand-authored fictional fixtures enter this adapter. Never call it with
 * provider output: it does not authorize repairing historical answers. */
export function fictionalQuotationClaim<F>(c:SourceReadingClaim,claim:{Q:unknown;facts:F[]},projectRelated?:(project:(v:unknown)=>unknown)=>void){
 const labels=sourceIdentifiedQuoteDictionary(c,claim.Q),dict=sourceQuoteDictionary(c,labels.quotes),all=c.clauses.map((_,i)=>i);
 const original=claim.Q as ({id:string}|string)[];
 const references=new Map<string,unknown>();
 labels.quotes.forEach((q,i)=>{
  const [start,end]=resolveSourceOrderedQuote(c,q,all),first=c.clauses.findIndex(([a,b])=>a<=start&&start<b),last=c.clauses.findIndex(([a,b])=>a<end&&end<=b),quote=c.grid.text.slice(start,end);
  const local=c.grid.text.slice(c.clauses[first][0],c.clauses[last][1]);let found=false;
  for(let at=local.indexOf(quote);at>=0;at=local.indexOf(quote,at+1)){if(c.clauses[first][0]+at===start){found=true;break;}}
  if(!found)throw Error("fictional_fixture_missing_original_occurrence");
  references.set(typeof original[i]==="string"?(original[i] as string).split("|")[0]:(original[i] as {id:string}).id,(()=>{const ref=`${first}-${last}:${quote}`;let count=0;for(let at=local.indexOf(quote);at>=0;at=local.indexOf(quote,at+1))count++;if(count===1)return ref;const a=start-c.clauses[first][0],z=end-c.clauses[first][0];for(let extra=1;extra<=local.length;extra++)for(let left=0;left<=extra;left++){const lo=a-left,hi=z+extra-left;if(lo<0||hi>local.length)continue;const outer=local.slice(lo,hi);if(local.indexOf(outer)!==local.lastIndexOf(outer)||outer.indexOf(quote)!==outer.lastIndexOf(quote))continue;if(/[\uD800-\uDBFF]$/.test(local.slice(0,lo))||/^[\uDC00-\uDFFF]/.test(local.slice(hi)))continue;return{reference:`${first}-${last}:${outer}`,focus:quote};}throw Error("fictional_fixture_unrepresentable_unique_focus");})());
 });
 const project=(v:unknown):unknown=>typeof v==="string"?(references.get(v)??v):Array.isArray(v)?v.map(project):v&&typeof v==="object"?Object.fromEntries(Object.entries(v).map(([k,x])=>[k,project(x)])):v;
 const obligations=sourceClaimObligations(c),bindings:Record<string,number>={};
 claim.facts.forEach((row,at)=>{
  const f=sourceDictionaryFact(c,sourceIdentifiedFact(row,labels),dict).fact,ids=sourceDeclaredOrderedEvidence(c,f);
  const action=f.m.k==="relation"?resolveSourceOrderedQuote(c,f.m.a,ids):null;
  for(const i of sourceMatchedTasks(obligations,f.m,ids,action,[]))bindings[`t${i}`]??=at;
 });
 if(Object.keys(bindings).length!==obligations.length)throw Error("fictional_fixture_has_uncovered_obligation");
 const scopes:unknown[]=[],scopeIds=new Map<string,string>();
 const rowProject=(raw:unknown):unknown=>{const row=project(raw) as {m:Record<string,unknown>;O:unknown[];[k:string]:unknown},m={...row.m},O=[...row.O];let s:string|null=null;
  if(m.g!=="unconditional"){const key=JSON.stringify([m.g,m.G,O[3]]);s=scopeIds.get(key)??`s${scopes.length}`;if(!scopeIds.has(key)){scopeIds.set(key,s);scopes.push({id:s,g:m.g,G:m.G,proof:O[3]});}}
  delete m.g;delete m.G;return{...row,m,O:[O[0],O[1],O[2],O[4]],s};};
 const grouped:Record<string,unknown>={},possessions:unknown[]=[],sets:unknown[]=[],order:number[]=[];
 c.clauses.forEach((_,R)=>{grouped[`f${R}`]=claim.facts.flatMap((row,i)=>{const value=row as F&{R:number;m:{k:string;P?:string}};if(value.R!==R)return[];
  if(value.m.P==="has"){possessions.push(rowProject(value));return[];}if(value.m.k==="set"){sets.push(rowProject(value));return[];}
  order.push(i);const {R:_anchor,...fact}=value;void _anchor;return[rowProject(fact)];});});
 const T=obligations.map((_,i)=>{const index=bindings[`t${i}`],row=claim.facts[index] as F&{R:number};const local=order.filter(old=>old<=index&&(claim.facts[old] as F&{R:number}).R===row.R).length-1;return `f${row.R}:${local}`;});
 projectRelated?.(rowProject);
 const result={...grouped,possessions,sets,T} as Record<string,unknown>&{T:string[]};fixtureScopes.set(result,scopes);return result;

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
 answer[`c${c.claimNo}`]=fictionalQuotationClaim(reading,answer[`c${c.claimNo}`],project=>{for(const key of keys)if(key.startsWith("loop"))answer[key]=project(answer[key]);});
 answer.scopes=fictionalScopesFor(answer[`c${c.claimNo}`]);
 return {v:34,sourceDigest:input.target.sourceDigest,claimNo:input.target.claimNo,...answer} as typeof answer & {v:number;sourceDigest:string;claimNo:number};
}
