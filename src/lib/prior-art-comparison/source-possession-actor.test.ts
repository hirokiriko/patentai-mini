import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions} from "./proposition-extraction";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";

// Handwritten fictional responses. Never adapt or repair a provider answer.
function fixture(kind:"postposed"|"explicit"|"absent"){
 const f=fictionalInputs(),text=kind==="postposed"?"青センサと、読取器を備える検査装置。":kind==="explicit"?"筐体は青センサと、読取器を備える。":"青センサと、読取器を備える。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks);
 const u=kind==="postposed"?["1-1:検査装置"]:kind==="explicit"?["0-0:筐体"]:null;
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:[],c1:{possessions:[{R:1,s:null,m:{u,x:"capability",p:"positive",k:"relation",P:"has",J:[["0-0:青センサ"],["1-1:読取器"]],a:"1-1:備える"},O:[null,null,null,null],F:null}],sets:[],f0:[],f1:[],T:[]}}}));
 return{chunks,plan,answers};
}
it.each(["postposed","explicit","absent"] as const)("preserves the supplied %s possessor and every member without rewriting the response",async kind=>{
 const f=fixture(kind),before=JSON.stringify(f.answers),result=await assembleSourceClaims(f.plan,f.answers);
 const expected=kind==="postposed"?"検査装置":kind==="explicit"?"筐体":null;
 for(const source of result.sources){
  expect(source.facts).toHaveLength(1);
  expect(source.facts[0].meaning).toMatchObject({kind:"relation",predicate:"has",subject:expected,objects:["青センサ","読取器"]});
 }
 expect(decodeSourcePropositions(f.chunks,result)).toBeDefined();
 expect(JSON.stringify(f.answers)).toBe(before);
});
it("does not silently reconstruct an omitted printed possessor from source context",async()=>{
 const f=fixture("postposed"),correct=await assembleSourceClaims(f.plan,f.answers),missing=structuredClone(f.answers);
 for(const answer of missing)answer.value.c1.possessions[0].m.u=null;
 const before=JSON.stringify(missing),observed=await assembleSourceClaims(f.plan,missing);
 // Structural decoding is not semantic QA. The omission remains observable
 // and fails comparison with the complete expected meaning; it is not repaired.
 expect(observed).not.toEqual(correct);
 for(const source of observed.sources)expect(source.facts[0].meaning.subject).toBeNull();
 expect(JSON.stringify(missing)).toBe(before);
});
it("rejects an invented actor quote instead of substituting the actual apparatus",async()=>{
 const f=fixture("postposed");for(const answer of f.answers)answer.value.c1.possessions[0].m.u=["0-0:検査装置"];
 const before=JSON.stringify(f.answers);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
 expect(JSON.stringify(f.answers)).toBe(before);
});

it.each(["absent","controller","local"] as const)("keeps possession separate from a mode action with actor=%s",async kind=>{
 const controlled=kind!=="absent",actor=kind==="controller"?"制御器":"駆動器";
 const f=fictionalInputs(),text="青センサを備え、第１の運転モードは光モードであり、光モードでは、"+(controlled?(kind==="controller"?"制御器により、":"駆動器が、"):"")+"青弁を開くことを特徴とする検査装置。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks),action=controlled?4:3;
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,
  scopes:[{id:"s0",g:"when",G:[["2-2:光モードでは"]],proof:"1-2:第１の運転モードは光モードであり、光モードでは、"}],
  c1:{possessions:[{R:0,s:null,m:{u:[`${action}-${action}:検査装置`],x:"capability",p:"positive",k:"relation",P:"has",J:[["0-0:青センサ"]],a:"0-0:備え"},O:[null,null,null,null],F:null}],sets:[],
   ...Object.fromEntries(Array.from({length:action+1},(_,i)=>[`f${i}`,i===action?[{s:"s0",m:{u:controlled?[`3-3:${actor}`]:null,x:"operation",p:"positive",k:"relation",P:"opens",J:[[`${action}-${action}:青弁`]],a:`${action}-${action}:開く`},O:[null,null,null,null],F:null}]:[]])),T:[`f${action}:0`]}}}));
 for(const [i,answer] of answers.entries()){const checked=await plan.tasks[i].schema.validate!(answer.value);expect(checked.success,JSON.stringify({target:JSON.parse(plan.tasks[i].prompt).target,error:checked.success?null:checked.error})).toBe(true);}
 const before=JSON.stringify(answers),result=await assembleSourceClaims(plan,answers);
 for(const source of result.sources){
  expect(source.facts.find(v=>v.meaning.kind==="relation"&&v.meaning.predicate==="has")?.meaning).toMatchObject({subject:"検査装置",objects:["青センサ"]});
  expect(source.facts.find(v=>v.meaning.kind==="relation"&&v.meaning.predicate==="opens")?.meaning).toMatchObject({subject:controlled?actor:null,context:"operation",objects:["青弁"],guard:{relation:"when",conditions:["光モードでは"]}});
 }
 expect(decodeSourcePropositions(chunks,result)).toBeDefined();
 expect(JSON.stringify(answers)).toBe(before);
 // Supplied fixtures check faithful projection, not future model quality.
 // The apparatus remains the possessor even when the mode action has no actor.
});
