import {expect,it} from "vitest";
import {sourceReadingClaim} from "./source-clause-coverage";
import {projectClaimScopeLanes} from "./source-claim-scope-projection";
import {resolveClaimLiteralReference,mapClaimLiteralFact,claimLiteralDictionary} from "./source-claim-literal-refs";
import {compareProposition,type Meaning,type SourceProposition,type TargetProposition} from "./propositions";

// Fictional supplied answers only. Projection cannot discover an omitted
// temporal condition; original-source QA must still review every condition.
const text="冬モードでは、制御器により、白管で流体を減圧した後、青器にて吸熱させる。";
const claim=sourceReadingClaim(1,text);
const mode="0-0:冬モードでは",after="2-2:白管で流体を減圧した後";
function fixture(){return {d:"fictional",scopes:[{id:"s0",g:"when",G:[[mode],[after]],proof:"0-2:冬モードでは、制御器により、白管で流体を減圧した後、"}],c1:{possessions:[],sets:[],f0:[],f1:[],f2:[],f3:[
 {s:"s0",m:{u:["0-0:冬モード"],x:"operation",p:"positive",k:"relation",P:"absorbs_heat",J:[["3-3:青器"]],a:"3-3:吸熱させる"},O:[null,null,null,null],F:null},
 {s:"s0",m:{u:["1-1:制御器"],x:"operation",p:"positive",k:"relation",P:"executes",J:[["3-3:青器にて吸熱させる"]],a:"3-3:吸熱させる"},O:[null,null,null,null],F:null},
 ],T:["f3:0"]}};}
const heat=(conditions=["冬モードでは","白管で流体を減圧した後"]):Meaning=>({kind:"relation",subject:"冬モード",context:"operation",polarity:"positive",guard:{relation:"when",conditions},predicate:"absorbs_heat",objects:["青器"]});
const source=(meaning:Meaning,id="s1"):SourceProposition=>({id,scope:"scope",claimNo:1,basis:[[0,text.length]],meaning,authority:"extracted"});
const target=(meaning:Meaning):TargetProposition=>({id:"t1",targetId:"t",span:[0,text.length],scope:"scope",claimNo:1,sourceIds:["s1"],meaning});

it("preserves both explicit mode and after condition for heat and continuing controller without rewriting",()=>{
 const raw=fixture(),before=JSON.stringify(raw),result=projectClaimScopeLanes(raw,1,claim);
 for(const row of result.facts){
  expect(row.m).toMatchObject({g:"when",G:[[mode],[after]],x:"operation"});
  expect(()=>mapClaimLiteralFact(row,claimLiteralDictionary(claim))).not.toThrow();
 }
 expect(result.facts[0].m).toMatchObject({u:["0-0:冬モード"]});
 expect(result.facts[1].m).toMatchObject({u:["1-1:制御器"]});
 expect(JSON.stringify(raw)).toBe(before);
});

it("keeps condition and combined proof at their exact original occurrences",()=>{
 const raw=fixture(),s=raw.scopes[0];
 for(const ref of [mode,after,s.proof]){const span=resolveClaimLiteralReference(claim,ref);expect(text.slice(...span)).toBe(ref.slice(ref.indexOf(":")+1));}
 expect(()=>resolveClaimLiteralReference(claim,"3-3:白管で流体を減圧した後")).toThrow();
});

it("does not pretend projection detects a missing temporal guard; the comparison rejects its loss",()=>{
 const raw=fixture();raw.scopes[0].G=[[mode]];raw.scopes[0].proof=mode;
 const result=projectClaimScopeLanes(raw,1,claim);
 expect(result.facts[0].m).toMatchObject({G:[[mode]]}); // No software completion.
 expect(compareProposition(target(heat(["冬モードでは"])),[source(heat())])).toMatchObject({relation:"unresolved",rule:"guard_mismatch"});
 expect(compareProposition(target(heat()),[source(heat(["冬モードでは"]))])).toMatchObject({relation:"unresolved",rule:"guard_mismatch"});
});

it("rejects upgrading a temporal-qualified action to an unconditional one",()=>{
 const m=heat(),unconditional:Meaning={...m,guard:{relation:"unconditional",conditions:[]}};
 expect(compareProposition(target(unconditional),[source(m)])).toMatchObject({relation:"unresolved",rule:"guard_lost"});
 expect(compareProposition(target(m),[source(m)])).toMatchObject({relation:"entailed",rule:"relation_matches"});
});

it("preserves an ordinary heat fact governed only by its printed mode",()=>{
 const m=heat(["冬モードでは"]);
 expect(compareProposition(target(m),[source(m)])).toMatchObject({relation:"entailed",rule:"relation_matches"});
});

it("retains ordinary ordered routes without using component order to fill a heat guard",()=>{
 const route:Meaning={kind:"path",subject:"冬モード",context:"operation",polarity:"positive",guard:{relation:"unconditional",conditions:[]},origin:"白管",destination:"黒槽",via:["青器"],bypass:[],extent:"segment",relation:"route"};
 expect(compareProposition(target(route),[source(route)])).toMatchObject({relation:"entailed",rule:"path_matches"});
 expect(compareProposition(target(heat()),[source(route)])).toMatchObject({relation:"unresolved",rule:"guard_mismatch"});
});
