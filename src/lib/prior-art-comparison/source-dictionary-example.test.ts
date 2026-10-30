import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceDictionaryPropositionModelSchemaFor} from "./source-semantic-wire";

it("keeps possession and a postposed component's detection/output function as distinct explicit facts",async()=>{
  const f=fictionalInputs(),text="【請求項1】読取器は、温度を検出して出力する青センサを備える。";
  f.inputs.draft=parseComparisonSource(text,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const O=[null,null,null,null,null];
  const m={x:"capability",g:"unconditional",G:[],p:"positive",k:"relation"};
  const raw={v:21,s:input.sources.map(s=>({d:s.sourceDigest,c1:{Q:["0-0:読取器","1-1:青センサ","1-1:備える","1-1:温度を検出して出力する"],facts:[
    {R:1,m:{...m,u:[0],P:"has",J:[[1]],a:2},O,F:null},
    {R:1,m:{...m,u:[1],P:"executes",J:[[3]],a:3},O,F:null},
  ]}}))};
  const result=await sourceDictionaryPropositionModelSchemaFor(plan).validate!(raw);
  expect(result.success).toBe(true);
  if(result.success){
    const facts=decodeSourcePropositions(plan,result.value).facts;
    expect(facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="has"&&f.meaning.subject==="読取器")).toBe(true);
    expect(facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="executes"&&f.meaning.subject==="青センサ"&&f.meaning.objects[0]==="温度を検出して出力する")).toBe(true);
  }
});
