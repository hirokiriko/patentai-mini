import {expect,it} from "vitest";
import {sourceReadingClaim} from "./source-clause-coverage";
import {assertSourceSemanticReading,sourceConditionalPropertyGuards,type CheckedSourceFact} from "./source-semantic-check";
import type {Span} from "./propositions";

const text="青機を停止し、赤弁を閉じたときの、流入側の減圧速度が、流出側の減圧速度よりも速い。";
const claim=sourceReadingClaim(1,text),group=sourceConditionalPropertyGuards(claim)[0];
function property():CheckedSourceFact{return {kind:"relation",predicate:"greater_than",polarity:"positive",polarityProof:null,
 action:group.property,evidence:[[0,text.length]],objectSpans:[],guardSpans:group.parts.map(s=>[s]),guardProof:group.proof,identity:"fictional-property"};}
it("requires both printed premises and accepts either complete AND citation form without changing the answer",()=>{
 expect(group.parts.map(s=>text.slice(...s))).toEqual(["青機を停止し","赤弁を閉じたとき"]);
 for(const guards of [group.parts.map(s=>[s]),[[group.proof]]]){
  const fact={...property(),guardSpans:guards},before=JSON.stringify(fact);
  expect(()=>assertSourceSemanticReading(claim,[fact],[])).not.toThrow();expect(JSON.stringify(fact)).toBe(before);
 }
});
it.each(["first_missing","second_missing","proof_only","proof_short","broad_action","other_occurrence"])("rejects a lost coordinated premise: %s",mode=>{
 const fact=property();
 if(mode==="first_missing")fact.guardSpans.shift();
 if(mode==="second_missing")fact.guardSpans.pop();
 if(mode==="proof_only")fact.guardSpans=[];
 if(mode==="proof_short")fact.guardProof=group.parts[1];
 if(mode==="broad_action"){fact.action=[group.proof[0],group.property[1]];fact.guardSpans=[group.parts.slice(1)];}
 if(mode==="other_occurrence")fact.guardSpans=group.parts.map(s=>[[s[0]+text.length,s[1]+text.length]]);
 const before=JSON.stringify(fact);expect(()=>assertSourceSemanticReading(claim,[fact],[])).toThrow();expect(JSON.stringify(fact)).toBe(before);
});
it("accepts ordered adjacent fragments within each guard term without changing them",()=>{
 for(const fragments of [2,3,4]){
  const fact=property();
  fact.guardSpans=group.parts.map(([start,end])=>Array.from({length:fragments},(_,i)=>
   [start+i,i===fragments-1?end:start+i+1] as Span));
  const before=JSON.stringify(fact);
  expect(()=>assertSourceSemanticReading(claim,[fact],[])).not.toThrow();
  expect(JSON.stringify(fact)).toBe(before);
 }
});
it.each(["gap","different_terms","reversed","overlap","wrong_occurrence","short_proof"])("rejects incomplete or unrelated split premises: %s",mode=>{
 const fact=property(),[start,end]=group.parts[0],cut=start+2;
 fact.guardSpans=[[[start,cut],[cut,end]],[group.parts[1]]];
 if(mode==="gap")fact.guardSpans[0][1][0]++;
 if(mode==="different_terms")fact.guardSpans=[[[start,cut]],[[cut,end]],[group.parts[1]]];
 if(mode==="reversed")fact.guardSpans[0].reverse();
 if(mode==="overlap")fact.guardSpans[0][1][0]--;
 if(mode==="wrong_occurrence")fact.guardSpans[0][1]=[cut+text.length,end+text.length];
 if(mode==="short_proof")fact.guardProof=group.parts[1];
 const before=JSON.stringify(fact);
 expect(()=>assertSourceSemanticReading(claim,[fact],[])).toThrow("comparison_source_semantic_incomplete");
 expect(JSON.stringify(fact)).toBe(before);
});
it("does not join fragments from separate real occurrences of the same premise",()=>{
 const repeated=sourceReadingClaim(1,text+text),second=sourceConditionalPropertyGuards(repeated)[1];
 const fact=property(),cut=group.parts[0][0]+2;
 fact.guardSpans=[[[group.parts[0][0],cut],[second.parts[0][0]+2,second.parts[0][1]]],[group.parts[1]]];
 // A wide proof containing both occurrences cannot supply the missing term.
 fact.guardProof=[group.proof[0],second.proof[1]];
 expect(()=>assertSourceSemanticReading(repeated,[fact],[])).toThrow("comparison_source_semantic_incomplete");
});
it("does not promote the stopped premise into an independently asserted action",()=>{
 const at=text.indexOf("停止し"),fact={...property(),predicate:"stops",action:[at,at+3] as Span,guardSpans:[],guardProof:null};
 expect(()=>assertSourceSemanticReading(claim,[property(),fact],[])).toThrow();
});
it.each([
 "青機を停止し、赤弁を閉じる。",
 "青機を停止した後も、赤弁が開いた状態を維持する。",
 `「${text}」という例。`,
 "青機を停止し。赤弁を閉じたときの、流入側の減圧速度が流出側の減圧速度よりも速い。",
])("does not impose this property guard on an unrelated assertion: %s",original=>{
 expect(sourceConditionalPropertyGuards(sourceReadingClaim(1,original))).toEqual([]);
});
it("keeps a later independent stop separate from the conditional occurrence",()=>{
 const original=text+"青機を停止する。",c=sourceReadingClaim(1,original),at=original.lastIndexOf("停止する");
 const stop={...property(),predicate:"stops",action:[at,at+4] as Span,guardSpans:[],guardProof:null};
 expect(()=>assertSourceSemanticReading(c,[property(),stop],[])).not.toThrow();
});
