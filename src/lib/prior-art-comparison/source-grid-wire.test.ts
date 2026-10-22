import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { propositionSourceInput, decodeSourcePropositions } from "./proposition-extraction";
import { directSourcePropositionModelSchemaFor } from "./source-direct-quotes";
import { sourceGridPropositionModelSchemaFor, propositionSourceGridTransport,assertSourceGridProviderSchema } from "./source-grid-wire";
import { fixtureSourceGridWire,fixtureSourceGridReading } from "./source-grid-fixtures.test-support";
import { sourceCitationGrid,sourceCellRef } from "./source-citation-grid";
import { SOURCE_GRID_ACTION_EXAMPLE } from "./source-grid-prompt";
import { fixtureGridWire } from "../../../scripts/prior-art-grid-fixture.mjs";

function setup(text="装置は赤色弁を備える。装置は赤色弁を開く。") {
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】"+text,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】"+text,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const q=(quote:string,before:string)=>({quote,before,after:"",edge:"start" as const});
  const fact={meaning:{subject:[q("装置","")],context:"capability",guardRelation:"unconditional",guardConditions:[],
    polarity:"positive",kind:"relation",predicate:"has",objects:[[q("赤色弁","装置は")]]},operators:null,routeFrame:null};
  const raw={locatorVersion:12,sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,c1:[structuredClone(fact)]}))};
  const wire=fixtureSourceGridReading(fixtureSourceGridWire(raw,input),input,()=>[[0,11]]);
  return {plan,input,raw,wire,model:sourceGridPropositionModelSchemaFor(plan)};
}
it("resolves supplied occurrence IDs to the identical domain result without quote generation",async()=>{
  const f=setup(),wire=f.wire,before=JSON.stringify(wire);
  const expected=await directSourcePropositionModelSchemaFor(f.plan).validate!(f.raw);
  const actual=await f.model.validate!(wire);
  expect(expected.success).toBe(true);expect(actual).toEqual(expected);
  if(actual.success)expect(()=>decodeSourcePropositions(f.plan,actual.value)).not.toThrow();
  expect(JSON.stringify(wire)).toBe(before);
  const transport=propositionSourceGridTransport(f.input);
  expect(transport.sources[0].source.claims[0].grid).toEqual(sourceCitationGrid("装置は赤色弁を備える。装置は赤色弁を開く。").rows);
  expect(transport.sources[0].source.claims[0]).not.toHaveProperty("parts");
  expect(transport.sources[0].source.claims[0].clauseRefs).toEqual([[0,0,1,0],[1,1,2,0]]);
});
it("validates the fictional conditional action example with separate exact clauses",async()=>{
  const f=fictionalInputs(),text="【請求項1】"+SOURCE_GRID_ACTION_EXAMPLE.text;
  f.inputs.draft=parseComparisonSource(text,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire={v:14,s:input.sources.map(s=>({d:s.sourceDigest,c1:[SOURCE_GRID_ACTION_EXAMPLE.fact],Y:SOURCE_GRID_ACTION_EXAMPLE.Y}))};
  const result=await sourceGridPropositionModelSchemaFor(plan).validate!(wire);
  expect(result.success).toBe(true);
  if(result.success){
    expect(()=>decodeSourcePropositions(plan,result.value)).not.toThrow();
    const scripted=fixtureGridWire(result.value,propositionSourceGridTransport(input));
    expect(scripted).toEqual(wire);
  }
  expect(propositionSourceGridTransport(input).sources[0].source.claims[0].clauseRefs).toEqual(SOURCE_GRID_ACTION_EXAMPLE.fact.W);
});
it.each(["nearly_whole_claim","punctuation","unrelated_clause"])("rejects reading evidence unrelated to actual fact roles: %s",async mode=>{
  const f=setup(),s=(f.wire.s as Record<string,unknown>[])[0],fact=(s.c1 as Record<string,unknown>[])[0];
  const grid=sourceCitationGrid("装置は赤色弁を備える。装置は赤色弁を開く。");
  const span:[number,number]=mode==="nearly_whole_claim"?[0,grid.text.length-1]:mode==="punctuation"?[10,11]:[11,grid.text.length];
  fact.W=[sourceCellRef(grid,span)];s.Y=mode==="unrelated_clause"?[["?unrepresented"],["c1:0"]]:[["c1:0"],["c1:0"]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("rejects ref siblings instead of silently ignoring them during provider validation",()=>{
  const schema={type:"object" as const,properties:{quote:{$ref:"#/definitions/quote"}},definitions:{quote:{type:"string" as const}}};
  expect(()=>assertSourceGridProviderSchema(schema)).not.toThrow();
  expect(()=>assertSourceGridProviderSchema({...schema,properties:{quote:{...schema.properties.quote,description:"Action quote"}}})).toThrow("plan_limit");
});
it("checks final provider property and nesting limits after reading fields are added",()=>{
  const flat=(n:number)=>({type:"object" as const,properties:Object.fromEntries(Array.from({length:n},(_,i)=>[`k${i}`,{type:"string" as const}]))});
  expect(()=>assertSourceGridProviderSchema(flat(100))).not.toThrow();
  expect(()=>assertSourceGridProviderSchema(flat(101))).toThrow("plan_limit");
  let deep:import("ai").JSONSchema7={type:"string"};
  for(let i=0;i<5;i++)deep={type:"object",properties:{child:deep}};
  expect(()=>assertSourceGridProviderSchema(deep)).not.toThrow();
  expect(()=>assertSourceGridProviderSchema({type:"object",properties:{child:deep}})).toThrow("plan_limit");
});
it.each(["legacy","bad_cell","whole_term","unknown_key","missing_source","wrong_digest","missing_claim","wrong_enum","bad_operator"])("rejects invalid v14 wire %s",async mode=>{
  const f=setup(),wire=f.wire;
  const s=wire.s as {d:string;c1:{m:{J:unknown;P:unknown};O:unknown}[]}[];
  if(mode==="legacy")wire.v=13;
  if(mode==="bad_cell")s[0].c1[0].m.J=[[[0,10,0,10]]];
  if(mode==="whole_term")s[0].c1[0].m.J=[[[]]];
  if(mode==="unknown_key")wire.foreign=true;
  if(mode==="missing_source")s.pop();
  if(mode==="wrong_digest")s[0].d=s[1].d;
  if(mode==="missing_claim")delete (s[0] as Partial<typeof s[0]>).c1;
  if(mode==="wrong_enum")s[0].c1[0].m.P=100;
  if(mode==="bad_operator")s[0].c1[0].O=[];
  expect((await f.model.validate!(wire)).success).toBe(false);
});
