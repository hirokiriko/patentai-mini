import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput,type SourceExtraction} from "./proposition-extraction";
import {compactSourceWitness,expandSourceWitness} from "./proposition-witness";
import {sourceDictionaryPropositionModelSchemaFor,sourceOrderedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceReadingClaim} from "./source-clause-coverage";
import {sourceQuoteDictionary,sourceDictionaryFact} from "./source-reading-tasks";
const O=()=>({selection:null,extent:null,polarity:null,guard:null,context:null});
function planFor(text:string){const f=fictionalInputs(),original="【請求項1】"+text;f.inputs.draft=parseComparisonSource(original,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(original,d.id,"架空"));return makePlan(f.inputs,f.selection);}
function setup(){const plan=planFor("制御器は、非通電状態の場合、赤弁を閉じる。"),input=propositionSourceInput(plan);
 const claim=()=>({Q:["0-0:制御器","1-1:非通電状態の場合","2-2:赤弁","2-2:閉じる"],facts:[{R:2,m:{u:[0],x:"operation",g:"when",G:[[1]],p:"positive",k:"relation",P:"closes",J:[[2]],a:3},O:{...O(),guard:1},F:null}]});
 return {plan,model:sourceDictionaryPropositionModelSchemaFor(plan),wire:{v:21,s:input.sources.map(s=>({d:s.sourceDigest,c1:claim()}))}};}
it("resolves only claim-local AI quotes and preserves decoded order through witness roundtrip",async()=>{
 const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);
 if(r.success){const decoded=decodeSourcePropositions(f.plan,r.value);expect(expandSourceWitness(decoded.raw)).toEqual(r.value);}
});
it.each(["missing_R","wrong_R","wrong_Q_index","old_quote","missing_quote","duplicate_Q","unused_Q","duplicate_term_index","bare_operator","W","T","legacy_version"])("rejects %s without repair",async mode=>{
 const f=setup(),c=f.wire.s[0].c1,p=c.facts[0] as typeof c.facts[number]&Record<string,unknown>;
 if(mode==="missing_R")delete (p as Record<string,unknown>).R;if(mode==="wrong_R")p.R=3;
 if(mode==="wrong_Q_index")p.m.a=99;if(mode==="old_quote")c.Q[3]="2:閉じる";
 if(mode==="missing_quote")c.Q[2]="2-2:青弁";if(mode==="duplicate_Q")c.Q.push(c.Q[0]);
 if(mode==="unused_Q")c.Q.push("0-0:制御器は");if(mode==="duplicate_term_index")p.m.J=[[2,2]];
 if(mode==="bare_operator")(p.O as Record<string,unknown>).guard={first:1,last:1};
 if(mode==="W")p.W=[0,1,2];if(mode==="T")p.T=[0];if(mode==="legacy_version")f.wire.v=20;
 expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("never borrows a quote from a different claim or range",()=>{
 const a=sourceReadingClaim(1,"赤弁を閉じる。"),b=sourceReadingClaim(2,"青弁を閉じる。");
 expect(()=>sourceQuoteDictionary(b,["0-0:赤弁"])).toThrow();
 const q=sourceQuoteDictionary(a,["0-0:赤弁"]);expect(()=>q.get(1)).toThrow();expect(()=>q.assertAllUsed()).toThrow();
});
it("rejects descending original-clause anchors even when each fact has its own exact meaning quote",async()=>{
 const plan=planFor("赤弁を閉じ、青弁を開く。"),input=propositionSourceInput(plan),wire={v:21,s:input.sources.map(s=>({d:s.sourceDigest,c1:{Q:["0-0:赤弁","0-0:閉じ","1-1:青弁","1-1:開く"],facts:[
 {R:1,m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"opens",J:[[2]],a:3},O:O(),F:null},
 {R:0,m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"closes",J:[[0]],a:1},O:O(),F:null}]}}))};
 expect((await sourceDictionaryPropositionModelSchemaFor(plan).validate!(wire)).success).toBe(false);
});
it("keeps outer frame IDs separate from inner quote indices",()=>{
 const c=sourceReadingClaim(1,"赤弁を閉じる。"),q=sourceQuoteDictionary(c,["0-0:赤弁","0-0:閉じる"]);
 const f={R:0,m:{u:null,J:[[0]],a:1},O:O(),F:17};expect(sourceDictionaryFact(c,f,q).fact.F).toBe(17);
 expect(()=>sourceDictionaryFact(c,{...f,F:{E:99,X:0,T:0,C:[],D:[]}},q)).toThrow();
});
it("retains the actual 64000-byte raw cap without allowing unused padding locators",async()=>{
 const f=setup();f.wire.s[0].c1.Q[0]="0-0:"+"甲".repeat(22000);expect(Buffer.byteLength(JSON.stringify(f.wire))).toBeGreaterThan(64000);
 expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("accepts compact explicit evidence even when its reversible repeated spelling exceeds 64000",async()=>{
 const names=Array.from({length:24},(_,i)=>`部品${i.toString().padStart(2,"0")}${"a".repeat(32)}`),text="装置は、"+names.join("と")+"を備える。",plan=planFor(text),input=propositionSourceInput(plan);
 const wire={v:21,s:input.sources.map(s=>({d:s.sourceDigest,c1:{Q:["0-0:装置","1-1:備える",...names.map(n=>`1-1:${n}`),`1-1:${text.slice(4)}`],facts:names.map((_,i)=>({R:1,m:{u:[0],x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"has",J:[[i+2]],a:1},O:{...O(),context:names.length+2},F:null}))}}))};
 const expanded=wire.s.map(s=>s.c1.facts.map(f=>s.c1.Q[f.O.context]));expect(Buffer.byteLength(JSON.stringify(expanded))).toBeGreaterThan(64000);expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(64000);
 const result=await sourceDictionaryPropositionModelSchemaFor(plan).validate!(wire);expect(result.success).toBe(true);
});
it("keeps the unchanged 32000-byte final witness cap for a compact dictionary of many composite terms",async()=>{
 const pieces=Array.from({length:20},(_,i)=>`${i.toString().padStart(2,"0")}${"x".repeat(18)}`),text="装置は、"+pieces.join("と")+"を備える。",plan=planFor(text),input=propositionSourceInput(plan),combinations:number[][]=[];
 for(let a=0;a<17;a++)for(let b=a+1;b<18;b++)for(let c=b+1;c<19;c++)for(let d=c+1;d<20;d++)if(combinations.length<94)combinations.push([a,b,c,d]);
 const wire={v:21,s:input.sources.map(s=>({d:s.sourceDigest,c1:{Q:["0-0:装置","1-1:備える",...pieces.map(n=>`1-1:${n}`)],facts:combinations.map(ids=>({R:1,m:{u:[0],x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"has",J:[ids.map(i=>i+2)],a:1},O:O(),F:null}))}}))};
 const raw:SourceExtraction={sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,facts:combinations.map(ids=>{const value=ids.map(i=>pieces[i]).join("");return {claimNo:1,basis:[[0,text.length]],meaning:{subject:"装置",context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",kind:"relation",predicate:"has",objects:[value]},bindings:[{term:"装置",spans:[[0,2]]},{term:value,spans:ids.map(i=>[text.indexOf(pieces[i]),text.indexOf(pieces[i])+20])}],operators:O(),routeFrame:null};})}))};
 expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThan(64000);expect(Buffer.byteLength(JSON.stringify(compactSourceWitness(raw)))).toBeGreaterThan(32000);
 expect(()=>decodeSourcePropositions(plan,raw)).toThrow();expect((await sourceDictionaryPropositionModelSchemaFor(plan).validate!(wire)).success).toBe(false);
});
it("does not accept an old v20 answer as v21",async()=>{const f=setup();const old={v:20,s:f.wire.s.map(s=>({d:s.d,c1:[[],[],[{m:{u:["0-0:制御器"],x:"operation",g:"when",G:[["1-1:非通電状態の場合"]],p:"positive",k:"relation",P:"closes",J:[["2-2:赤弁"]],a:"2-2:閉じる"},O:{...O(),guard:"1-1:非通電状態の場合"},F:null}]]}))};expect((await sourceOrderedPropositionModelSchemaFor(f.plan).validate!(old)).success).toBe(true);expect((await f.model.validate!(old)).success).toBe(false);});
