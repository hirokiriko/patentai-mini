import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {propositionSourceInput,decodeSourcePropositions} from "./proposition-extraction";
import {compactDirectSourcePropositionModelSchemaFor as sourcePropositionModelSchemaFor} from "./source-direct-quotes";
import {compactSourceWire,expandSourceWire,SOURCE_MEANING_ENUMS} from "./source-wire-compact";

function setup(text="装置は赤色弁を備える。"){
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】"+text,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】"+text,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const fact={meaning:{subject:[{part:0,quote:"装置"}],context:"capability",guardRelation:"unconditional",guardConditions:[],
    polarity:"positive",kind:"relation",predicate:"has",objects:[[{part:0,quote:"赤色弁"}]]},operators:null,routeFrame:null};
  const raw={locatorVersion:12,sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,c1:[structuredClone(fact)]}))};
  // Test mutations use the exact compact wire type of this fixed fixture.
  const wire=compactSourceWire(raw) as {v:number;s:{d:string;c1:{m:{u:string[];x:number;g:number;G:unknown[];p:number;k:number;P:number;J:string[][]};O:unknown;F:unknown}[]}[]};
  return {plan,raw,wire,model:sourcePropositionModelSchemaFor(plan)};
}
it("uses production v13 without changing any original term, evidence or fact",async()=>{
  const f=setup(),before=JSON.stringify(f.wire);
  expect(expandSourceWire(f.wire)).toEqual(f.raw);
  const result=await f.model.validate!(f.wire);expect(result.success).toBe(true);
  if(result.success)expect(()=>decodeSourcePropositions(f.plan,result.value)).not.toThrow();
  expect(JSON.stringify(f.wire)).toBe(before);
  expect((await f.model.validate!(f.raw)).success).toBe(false);
});
it.each(["p01:赤色弁","p-1:赤色弁","p1.0:赤色弁","p9007199254740992:赤色弁","p99:赤色弁","p0:","p0:別の弁"])("rejects invalid part spelling/location %s without fallback",async literal=>{
  const f=setup();f.wire.s[0].c1[0].m.J=[[literal]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["version","full_key","unknown_key","enum_negative","enum_fraction","enum_range","enum_string","foreign_claim","missing_source","extra_operator","unknown_context","mixed_quote"])("rejects noncanonical or foreign wire %s",async mode=>{
  const f=setup(),fact=f.wire.s[0].c1[0];
  if(mode==="version")f.wire.v=12;
  if(mode==="full_key")Object.assign(f.wire,{locatorVersion:13});
  if(mode==="unknown_key")Object.assign(fact,{unexpected:null});
  if(mode==="enum_negative")fact.m.x=-1;
  if(mode==="enum_fraction")fact.m.x=0.5;
  if(mode==="enum_range")fact.m.P=SOURCE_MEANING_ENUMS.predicate.length;
  if(mode==="enum_string")Object.assign(fact.m,{P:"has"});
  if(mode==="foreign_claim")Object.assign(f.wire.s[0],{c99:f.wire.s[0].c1});
  if(mode==="missing_source")f.wire.s.pop();
  if(mode==="extra_operator")fact.O=[null,null,null,null,null,null];
  if(mode==="unknown_context")Object.assign(fact.m,{J:[[["q","赤色弁","","","unknown"]]]});
  if(mode==="mixed_quote")Object.assign(fact.m,{J:[[{t:0,q:"赤色弁"}]]});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("preserves literal colons, newlines, enum words and explicit whole-claim proofs",()=>{
  const raw={meaning:{subject:[{part:3,quote:"has:operation\n甲"}],context:"operation"},
    operators:{selection:null,extent:null,polarity:null,guard:{quote:null,before:"",after:"",edge:"both"},context:null},
    routeFrame:{entry:{part:0,quote:"A:B"},exit:{quote:"end",before:"x",after:"",edge:"end"},route:{part:0,quote:"A:B"},exclusions:[],controls:[]}};
  expect(expandSourceWire(compactSourceWire(raw))).toEqual(raw);
});
it("enforces 31999/32000/32001 bytes on otherwise valid compact wire",async()=>{
  const f=setup("装置は赤色弁を備える。"+"x".repeat(6000)+"。"),original=structuredClone(f.wire.s[0].c1[0]);
  const proof=(n:number)=>[null,null,null,["q","装置","","は赤色弁を備える。"+"x".repeat(n),"start"],null];
  const bytes=()=>Buffer.byteLength(JSON.stringify(f.wire));let found=false;
  for(let n=1;n<=48;n++){
    f.wire.s[0].c1=Array.from({length:n},()=>({...structuredClone(original),O:proof(900)}));
    const last=f.wire.s[0].c1.at(-1)!;last.O=proof(0);
    const remaining=31999-bytes();
    if(remaining>=0&&remaining+2<=6000){last.O=proof(remaining);found=true;break;}
  }
  expect(found).toBe(true);expect(bytes()).toBe(31999);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  const last=f.wire.s[0].c1.at(-1)!,operator=(last.O as unknown[])[3] as string[];
  operator[3]+="x";expect(bytes()).toBe(32000);expect((await f.model.validate!(f.wire)).success).toBe(true);
  operator[3]+="x";expect(bytes()).toBe(32001);expect((await f.model.validate!(f.wire)).success).toBe(false);
});
