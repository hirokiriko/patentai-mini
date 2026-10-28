import type {SourceReadingClaim} from "./source-clause-coverage";
import type {Span} from "./propositions";
import {SOURCE_CAPACITY} from "./source-capacity";
import {sourceCellRef} from "./source-citation-grid";
import {decodeClaimCoordinateQuotes} from "./source-claim-coordinates";
const invalid=()=>new Error("comparison_source_literal_reference_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
/** Literal locator choices only: never choose a meaning or repair an answer.
 * Maximal repeated runs keep the input aid small. Original clauses and the
 * strict resolver remain authoritative; this is not an inventory of facts. */
export function claimLiteralReferenceChoices(c:SourceReadingClaim,clauseIds:readonly number[]){
 const choices:{reference:string;focus:string}[]=[];
 for(const id of clauseIds){
  const text=c.grid.text.slice(...c.clauses[id]),boundaries=[0];
  for(const point of text)boundaries.push(boundaries.at(-1)!+point.length);
  const suffixes=boundaries.slice(0,-1).map(at=>text.slice(at,at+80)).sort();
  const repeated=new Set<string>();
  for(let i=1;i<suffixes.length;i++){
   const a=suffixes[i-1],b=suffixes[i];let end=0;
   while(end<a.length&&end<b.length&&a[end]===b[end])end++;
   if(end&&/[\uD800-\uDBFF]/u.test(a[end-1]))end--;
   const focus=a.slice(0,end);
   if(focus.length>=2&&/[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9]/u.test(focus)&&!/[\p{P}\p{Z}\p{C}]/u.test(focus))repeated.add(focus);
  }
  for(const focus of repeated){
   const positions:number[]=[];for(let at=text.indexOf(focus);at>=0;at=text.indexOf(focus,at+1))positions.push(at);
   // A common preceding character makes this a redundant suffix of a longer run.
   if(positions.every(at=>at>0)&&new Set(positions.map(at=>text[at-1])).size===1)continue;
   for(const [index,at]of positions.entries()){
    // Largest surrounding window containing this focus once. If still
    // ambiguous, the existing outer/focus form cannot identify this span.
    let lo=boundaries.find(x=>x>(positions[index-1]??-1))!;
    let hi=boundaries.findLast(x=>x<(positions[index+1]??text.length+1)+focus.length-1)??text.length;
    hi=Math.min(hi,text.length);
    const unique=(a:number,b:number)=>{const q=text.slice(a,b);return text.indexOf(q)===a&&text.indexOf(q,a+1)<0;};
    if(lo>at||hi<at+focus.length||!unique(lo,hi))continue;
    // Shrink locator context without changing focus or splitting a code point.
    let left=boundaries.indexOf(lo),right=boundaries.indexOf(at);
    while(left<right){const mid=Math.ceil((left+right)/2);if(unique(boundaries[mid],hi))left=mid;else right=mid-1;}
    lo=boundaries[left];left=boundaries.indexOf(at+focus.length);right=boundaries.indexOf(hi);
    while(left<right){const mid=Math.floor((left+right)/2);if(unique(lo,boundaries[mid]))right=mid;else left=mid+1;}
    hi=boundaries[left];
    const choice={reference:`${id}-${id}:${text.slice(lo,hi)}`,focus};
    const span=resolveClaimLiteralReference(c,choice);
    if(span[0]!==c.clauses[id][0]+at||span[1]!==c.clauses[id][0]+at+focus.length)throw invalid();
    choices.push(choice);
    if(choices.length>SOURCE_CAPACITY.quotes||Buffer.byteLength(JSON.stringify(choices),"utf8")>SOURCE_CAPACITY.wireBytes)throw invalid();
   }
  }
 }
 return choices;
}
/** Select exact original text only. An optional unique outer quote locates a
 * unique inner focus without counting offsets or inventing outside context. */
export function resolveClaimLiteralReference(c:SourceReadingClaim,value:unknown):Span{
 if(record(value)){
  if(Object.keys(value).length!==2||!["reference","focus"].every(k=>Object.hasOwn(value,k))||typeof value.reference!=="string"||typeof value.focus!=="string"||!value.focus||value.focus.length>12000)throw invalid();
  const outer=resolveClaimLiteralReference(c,value.reference),text=c.grid.text.slice(...outer),first=text.indexOf(value.focus);
  if(first<0||text.indexOf(value.focus,first+1)>=0)throw invalid();
  const span:Span=[outer[0]+first,outer[0]+first+value.focus.length];sourceCellRef(c.grid,span);return span;
 }
 if(typeof value!=="string")throw invalid();
 const match=/^(0|[1-9]\d*)-(0|[1-9]\d*):([\s\S]+)$/u.exec(value);if(!match)throw invalid();
 const first=Number(match[1]),last=Number(match[2]),quote=match[3];
 if(![first,last].every(Number.isSafeInteger)||last<first||last-first>=12||!c.clauses[first]||!c.clauses[last]||quote.length>12000)throw invalid();
 const [start]=c.clauses[first],end=c.clauses[last][1],text=c.grid.text.slice(start,end),at=text.indexOf(quote);
 if(at<0||text.indexOf(quote,at+1)>=0)throw invalid();
 const span:Span=[start+at,start+at+quote.length];sourceCellRef(c.grid,span);return span;
}
/** Intern only already validated spans. Equal spans share an internal ID;
 * no actor, condition, fact or additional quotation is ever constructed. */
export function claimLiteralDictionary(c:SourceReadingClaim){
 const bySpan=new Map<string,string>(),encoded:{id:string;K:ReturnType<typeof sourceCellRef>}[]=[];
 const reference=(value:unknown)=>{const span=resolveClaimLiteralReference(c,value),key=span.join(":");const old=bySpan.get(key);if(old)return old;
  if(encoded.length>=SOURCE_CAPACITY.quotes)throw invalid();const id=`q${encoded.length}`;encoded.push({id,K:sourceCellRef(c.grid,span)});bySpan.set(key,id);return id;};
 return {reference,quotes:()=>decodeClaimCoordinateQuotes(c,encoded)};
}
/** Map only known citation-bearing positions. Unknown fields remain present
 * for the unchanged strict validator to reject; no field is silently dropped. */
export function mapClaimLiteralFact(value:unknown,dictionary:ReturnType<typeof claimLiteralDictionary>):Record<string,unknown>{
 if(!record(value)||!record(value.m)||!Array.isArray(value.O)||value.O.length!==5)throw invalid();
 const m={...value.m},term=(v:unknown)=>{if(!Array.isArray(v))throw invalid();return v.map(dictionary.reference);};
 for(const key of ["u","i","j"])if(Object.hasOwn(m,key)&&m[key]!==null)m[key]=term(m[key]);
 for(const key of ["G","M","V","B","J"])if(Object.hasOwn(m,key)){if(!Array.isArray(m[key]))throw invalid();m[key]=m[key].map(term);}
 if(Object.hasOwn(m,"a"))m.a=dictionary.reference(m.a);
 const proof=(v:unknown)=>v===null?null:dictionary.reference(v),O=value.O.map(proof);let F=value.F;
 if(record(F)){
  if(Object.keys(F).sort().join(',')!=="C,D,E,T,X"||!Array.isArray(F.C)||!Array.isArray(F.D))throw invalid();
  F={E:proof(F.E),X:proof(F.X),T:proof(F.T),C:F.C.map(proof),D:F.D.map(proof)};
 }
 return {...value,m,O,F};
}
