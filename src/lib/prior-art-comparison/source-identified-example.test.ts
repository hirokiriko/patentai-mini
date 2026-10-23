import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";

it("keeps nonconsecutive quote IDs and original emission order in the fictional worked example",async()=>{
  const f=fictionalInputs(),text="【請求項1】温度を検出して出力する青センサと、読取器を備える。";
  f.inputs.draft=parseComparisonSource(text,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan),O=[null,null,null,null,null];
  const common={x:"capability",g:"unconditional",G:[],p:"positive",k:"relation"};
  const raw={v:22,s:input.sources.map(s=>({d:s.sourceDigest,c1:{
    Q:["q8|0-0:青センサ","q3|0-0:温度を検出して出力する","q12|1-1:読取器","q6|1-1:備える"],facts:[
      {R:0,m:{...common,u:["q8"],P:"executes",J:[["q3"]],a:"q3"},O,F:null},
      {R:1,m:{...common,u:null,P:"has",J:[["q8"],["q12"]],a:"q6"},O,F:null},
    ],
  }}))};
  const model=sourceIdentifiedPropositionModelSchemaFor(plan),before=JSON.stringify(raw),result=await model.validate!(raw);
  expect(result.success).toBe(true);expect(JSON.stringify(raw)).toBe(before);
  if(result.success){
    const facts=decodeSourcePropositions(plan,result.value).facts;
    expect(facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="executes"&&f.meaning.subject==="青センサ")).toBe(true);
    expect(facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="has"&&f.meaning.subject===null)).toBe(true);
  }
  raw.s[0].c1.facts.reverse();expect((await model.validate!(raw)).success).toBe(false);
});
