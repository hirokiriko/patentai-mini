import type {SourceReadingClaim} from "./source-clause-coverage";
import type {Span} from "./propositions";
import {SOURCE_CAPACITY} from "./source-capacity";
import {sourceCellRef} from "./source-citation-grid";
import {decodeClaimCoordinateQuotes} from "./source-claim-coordinates";
const invalid=()=>new Error("comparison_source_literal_reference_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
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
