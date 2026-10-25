import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions} from "./proposition-extraction";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";

// Handwritten fictional answers exercise the existing strict decoder. No real
// provider response is changed or promoted to a successful extraction here.
function fixture(state="箱の外に設けられた",action=state,component="青センサ"){
 const f=fictionalInputs(),text=`${state}${component}と、読取器を備える検査装置。`;
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks);
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:[],c1:{
  possessions:[{R:1,s:null,m:{u:["1-1:検査装置"],x:"capability",p:"positive",k:"relation",P:"has",J:[[`0-0:${component}`],["1-1:読取器"]],a:"1-1:備える"},O:[null,null,null,null],F:null}],
  sets:[],f0:[{s:null,m:{u:[`0-0:${component}`],x:"capability",p:"positive",k:"relation",P:"is_state",J:[[`0-0:${state}`]],a:`0-0:${action}`},O:[null,null,null,null],F:null}],f1:[],T:["f0:0"],
 }}}));
 return{chunks,plan,answers};
}

it("preserves the complete placement, actor and possession through claim assembly without rewriting",async()=>{
 const f=fixture(),before=JSON.stringify(f.answers);
 for(const [i,a]of f.answers.entries())expect((await f.plan.tasks[i].schema.validate!(a.value)).success).toBe(true);
 const result=await assembleSourceClaims(f.plan,f.answers);
 for(const source of result.sources){
  expect(source.facts).toHaveLength(2);
  expect(source.facts[0].meaning).toMatchObject({predicate:"is_state",subject:"青センサ",objects:["箱の外に設けられた"],context:"capability",polarity:"positive"});
  expect(source.facts[1].meaning).toMatchObject({predicate:"has",subject:"検査装置",objects:["青センサ","読取器"]});
 }
 expect(decodeSourcePropositions(f.chunks,result)).toBeDefined();
 expect(JSON.stringify(f.answers)).toBe(before);
});

it.each(["short_action","missing_location","invented_location","wrong_clause"])("rejects incomplete or false placement citations without repairing J or a: %s",async kind=>{
 const f=fixture(),raw=f.answers[0].value,fact=raw.c1.f0[0];
 if(kind==="short_action")fact.m.a="0-0:設けられた";
 if(kind==="missing_location")fact.m.J=[["0-0:設けられた"]];
 if(kind==="invented_location")fact.m.a="0-0:箱の内に設けられた";
 if(kind==="wrong_clause")fact.m.a="1-1:箱の外に設けられた";
 const before=JSON.stringify(f.answers);
 expect((await f.plan.tasks[0].schema.validate!(raw)).success).toBe(false);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
 expect(JSON.stringify(f.answers)).toBe(before);
});

it("retains the distinct valid connection-state action without imposing a placement rule",async()=>{
 const f=fixture("読取器に接続された","接続された","センサ"),before=JSON.stringify(f.answers);
 const result=await assembleSourceClaims(f.plan,f.answers);
 for(const source of result.sources)expect(source.facts[0].meaning).toMatchObject({predicate:"is_state",subject:"センサ",objects:["読取器に接続された"]});
 expect(decodeSourcePropositions(f.chunks,result)).toBeDefined();
 expect(JSON.stringify(f.answers)).toBe(before);
});
