import { expect, it } from "vitest";
import type { JSONSchema7 } from "ai";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { decodeSourcePropositions, decodeTargetPropositions, propositionSourceInput, propositionSourceTransport,
  propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire } from "./proposition-fixtures.test-support";
import { resolvePropositionQuote, sourcePropositionModelSchemaFor, targetPropositionModelSchemaFor } from "./proposition-locators";
import { parseComparisonSource } from "./source";

function setup(){
  const f=fictionalInputs(),plan=makePlan(f.inputs,f.selection),sourceInput=propositionSourceTransport(propositionSourceInput(plan));
  const source=fictionalPropositionSource(sourceInput),sources=decodeSourcePropositions(plan,source);
  const generation=fictionalPropositionGeneration(batchInput(plan));
  const drafts=plan.flatMap(c=>{
    const results=generation.results.filter(r=>r.docId===c.candidateId).map(({docId,...r})=>{void docId;return r;});
    return validateAnswer(c,decodeGeneration(c,{results})).map(p=>({...p,...results.find(r=>r.baseClaimNo===p.baseClaimNo&&r.candidateClaimNo===p.candidateClaimNo)!}));
  });
  const targetInput=propositionTargetInput(plan,drafts,sources),target=fictionalPropositionTarget(propositionTargetTransport(targetInput));
  return {plan,sourceInput,source,targetInput,target,sourceSchema:sourcePropositionModelSchemaFor(plan),targetSchema:targetPropositionModelSchemaFor(targetInput)};
}
it("resolves exact repeated/overlapping quotes and UTF16 positions without normalization",()=>{
  expect(resolvePropositionQuote("甲😀甲甲甲","甲甲",1)).toEqual([4,6]);
  expect(resolvePropositionQuote("甲😀甲甲甲","😀",0)).toEqual([1,3]);
  expect(()=>resolvePropositionQuote("Ａ　甲","A 甲",0)).toThrow();
});
it.each(["empty","absent","negative","fraction","exhausted","surrogate_start","surrogate_end"])("rejects invalid exact locator %s",mode=>{
  const quote=mode==="empty"?"":mode==="absent"?"乙":mode==="surrogate_start"?"\ude00":mode==="surrogate_end"?"\ud83d":"甲";
  const occurrence=mode==="negative"?-1:mode==="fraction"?0.5:mode==="exhausted"?2:0;
  expect(()=>resolvePropositionQuote("甲😀甲",quote,occurrence)).toThrow();
});
it("round-trips source and target quotes through the actual model schemas without changing raw or meaning",async()=>{
  const f=setup(),sourceWire=fixturePropositionWire(f.source),targetWire=fixturePropositionWire(f.target);
  const original=JSON.stringify([sourceWire,targetWire]);
  const s=await f.sourceSchema.validate!(sourceWire),t=await f.targetSchema.validate!(targetWire);
  expect(s).toEqual({success:true,value:f.source});expect(t).toEqual({success:true,value:f.target});
  expect(JSON.stringify([sourceWire,targetWire])).toBe(original);
  if(s.success)expect(decodeSourcePropositions(f.plan,s.value)).toEqual(decodeSourcePropositions(f.plan,f.source));
  if(t.success)expect(decodeTargetPropositions(f.targetInput,t.value)).toEqual(decodeTargetPropositions(f.targetInput,f.target));
});
it("converts all frame/operator/attribution fields without rewriting selection or guard",async()=>{
  const f=setup(),a=f.target.targets[0].parts[0].atoms[0],s=a.basis[0];
  a.routeFrame={entry:s,exit:s,route:s,exclusions:[s],controls:[s]};
  a.operators={selection:s,extent:s,polarity:s,guard:s,context:s};
  a.meaning={kind:"set",subject:null,context:"unresolved",guard:{relation:"unresolved",conditions:[]},
    polarity:"reserved",selection:"unspecified",extent:"partial",members:["装置"]};
  expect(await f.targetSchema.validate!(fixturePropositionWire(f.target))).toEqual({success:true,value:f.target});
  // Wire validity alone never makes the intentionally inconsistent fact valid.
  expect(()=>decodeTargetPropositions(f.targetInput,f.target)).toThrow();
});
it.each(["legacy","mixed","absent_quote","unused","duplicate_locator","negative_index","outside_index","wrong_claim","other_source","wrong_version"])("rejects source wire %s before domain decoding",async mode=>{
  const f=setup(),w=fixturePropositionWire(f.source),s=w.sources[0].claims[0],fact=s.facts[0];
  if(mode==="legacy"){expect((await f.sourceSchema.validate!(f.source)).success).toBe(false);return;}
  if(mode==="mixed")fact.basis[0]=[0,1];
  if(mode==="absent_quote")s.locators[0].quote="原文にない引用";
  if(mode==="unused")s.locators.push({...s.locators[0],id:s.locators.length,quote:"架空"});
  if(mode==="duplicate_locator")s.locators.push({...s.locators[0]});
  if(mode==="negative_index")fact.meaning.subject=[-1];
  if(mode==="outside_index")fact.meaning.subject=[999];
  if(mode==="wrong_claim")s.claimNo=2;
  if(mode==="other_source")w.sources[0].sourceDigest=w.sources[1].sourceDigest;
  if(mode==="wrong_version")w.locatorVersion=0;
  expect((await f.sourceSchema.validate!(w)).success).toBe(false);
});
it.each(["legacy","other_target","gap","basis_outside","sentence_crossing"])("retains target boundary checks after resolving %s",async mode=>{
  const f=setup();
  if(mode==="legacy"){expect((await f.targetSchema.validate!(f.target)).success).toBe(false);return;}
  const t=f.target.targets.find(t=>t.id.endsWith(":common"))!,p=t.parts[0];
  if(mode==="gap")p.span[0]++;
  if(mode==="basis_outside")p.atoms[0].basis=[t.parts[1].span];
  if(mode==="sentence_crossing")p.span[1]=t.parts[1].span[1];
  const w=fixturePropositionWire(f.target);
  if(mode==="other_target")w.targets[0].id=w.targets[1].id;
  const result=await f.targetSchema.validate!(w);
  if(mode==="other_target")expect(result.success).toBe(false);
  else {expect(result.success).toBe(true);if(result.success)expect(()=>decodeTargetPropositions(f.targetInput,result.value)).toThrow();}
});
it("keeps complete source/target wire schemas within five object levels",()=>{
  const f=setup();
  for(const schema of [f.sourceSchema,f.targetSchema]){
    const root=schema.jsonSchema as JSONSchema7;
    const depth=(s:JSONSchema7,d=0):number=>{
      if(s.$ref){const name=s.$ref.split("/").at(-1)!;return depth(root.definitions![name] as JSONSchema7,d);}
      const own=d+(s.type==="object"?1:0);
      return Math.max(own,...Object.values(s.properties??{}).map(v=>depth(v as JSONSchema7,own)),
        ...(s.anyOf??[]).map(v=>depth(v as JSONSchema7,d)),...(s.items?[depth(s.items as JSONSchema7,own)]:[]));
    };
    expect(depth(root)).toBeLessThanOrEqual(5);
    expect(root.properties).toHaveProperty("locatorVersion");
    expect(JSON.stringify(root)).not.toContain("oneOf");
  }
});
it.each([[0,1.5],[0,-1],[0,1,2]])("does not silently repair invalid numeric coordinates in a fictional answer: %j",(...range)=>{
  const f=setup();
  Object.assign(f.source.sources[0].facts[0],{basis:[range]});
  expect(()=>fixturePropositionWire(f.source)).toThrow("fictional_locator_invalid");
});

function boundExample(text:string,second?:string) {
  const f=fictionalInputs();f.inputs.draft=parseComparisonSource("【請求項1】\n"+text+(second?"\n【請求項2】\n"+second:""),11,"draft-11");
  if(second)f.selection.draftClaimNos=[1,2];
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire={locatorVersion:6,sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,claims:s.source.claims.map(c=>({claimNo:c.claimNo,
    locators:[] as {id:number;quote:string|null;occurrence:number;firstPart:number;lastPart:number}[],requiredLoops:[],facts:[] as unknown[]}))}))};
  return {schema:sourcePropositionModelSchemaFor(plan),wire,row:wire.sources[0].claims[0],plan,input};
}
const citation=(quote:string|null,occurrence=0,firstPart=0,lastPart=firstPart)=>({quote,occurrence,firstPart,lastPart});
const citations=(...entries:ReturnType<typeof citation>[])=>entries.map((l,id)=>({id,...l}));
const neutralBound={selection:null,extent:null,polarity:null,guard:null,context:null};
const basis=(firstPart=0,lastPart=firstPart)=>[{firstPart,lastPart}];
function keyedExample(){
  const f=boundExample("装置は青色弁を備える。");
  f.row.locators=[{id:7,...citation("装置")},{id:304,...citation("青色弁")}];
  const fact={basis:basis(),meaning:{kind:"relation",subject:[7],context:"capability",
    guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"has",objects:[[304]]},
    operators:{...neutralBound},routeFrame:null};
  f.row.facts=[fact];return {...f,fact};
}
it("resolves sparse claim-local IDs independently of order without changing the selected part basis",async()=>{
  const f=keyedExample(),first=await f.schema.validate!(f.wire);expect(first.success).toBe(true);
  f.row.locators.reverse();const before=JSON.stringify(f.wire);
  expect(await f.schema.validate!(f.wire)).toEqual(first);expect(JSON.stringify(f.wire)).toBe(before);
  if(first.success)expect(first.value.sources[0].facts[0]).toMatchObject({basis:[[0,"装置は青色弁を備える。".length]],meaning:{subject:"装置",objects:["青色弁"]}});
});
it.each(["array_position","duplicate_id","duplicate_position","unused_id","wrong_claim","missing_id","outside_id","legacy_v5"])("rejects invalid claim-local source ID %s",async mode=>{
  const f=keyedExample();
  if(mode==="array_position")f.fact.meaning.subject=[0];
  if(mode==="duplicate_id")f.row.locators[1].id=7;
  if(mode==="duplicate_position")f.row.locators.push({...f.row.locators[0],id:305});
  if(mode==="unused_id")f.row.locators.push({id:305,...citation("備える")});
  if(mode==="wrong_claim")f.row.claimNo=2;
  if(mode==="missing_id")Reflect.deleteProperty(f.row.locators[0],"id");
  if(mode==="outside_id")f.row.locators[0].id=512;
  if(mode==="legacy_v5")f.wire.locatorVersion=5;
  expect((await f.schema.validate!(f.wire)).success).toBe(false);
});
it.each(["missing","duplicate","reordered","borrowed_quote","foreign_claim_field"])("rejects omitted or borrowed claim readings: %s",async mode=>{
  const f=boundExample("装置は青色弁を備える。","機器は赤色弁を備える。"),claims=f.wire.sources[0].claims;
  if(mode==="missing")claims.pop();
  if(mode==="duplicate")claims[1]=structuredClone(claims[0]);
  if(mode==="reordered")claims.reverse();
  if(mode==="borrowed_quote")claims[1].locators=[{id:0,...citation("青色弁")}];
  if(mode==="foreign_claim_field")Object.assign(claims[1],{facts:[{...keyedExample().fact,claimNo:1}]});
  expect((await f.schema.validate!(f.wire)).success).toBe(false);
});
it("allows canonical-only claims to have no new fact without treating that as semantic coverage",async()=>{
  const f=boundExample("前記第１の運転モードは紫色モードであり、装置を作動させる。");
  const result=await f.schema.validate!(f.wire);expect(result.success).toBe(true);
  if(result.success)expect(decodeSourcePropositions(f.plan,result.value).facts.some(f=>f.authority==="literal")).toBe(true);
});
it("derives composed terms only from exact fragments and preserves an implicit null subject",async()=>{
  const f=boundExample("第１、第２運転モードを備える。");
  f.row.locators=citations(citation("第１"),citation("運転モード"));
  f.row.facts=[{basis:basis(),meaning:{kind:"relation",subject:null,context:"capability",guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"has",objects:[[0,1]]},operators:neutralBound,routeFrame:null}];
  const result=await f.schema.validate!(f.wire);expect(result.success).toBe(true);
  if(result.success){const fact=result.value.sources[0].facts[0];expect(fact.meaning).toMatchObject({subject:null,objects:["第１運転モード"]});
    expect(fact.bindings).toEqual([{term:"第１運転モード",spans:[[0,2],[5,10]]}]);}
});
it.each([false,true])("does not widen the explicit part basis to fit a repeated endpoint (outside=%s)",async outside=>{
  const route="循環器から青色弁を経て循環器に戻る。",text=route+"甲".repeat(128)+"、別の循環器。",f=boundExample(text);
  const last=f.input.sources[0].source.claims[0].segments.length-1;
  f.row.locators=citations(citation(route),citation("循環器"),citation("循環器",outside?0:1,outside?last:0),citation("青色弁"));
  f.row.facts=[{basis:basis(),meaning:{kind:"path",subject:null,context:"operation",guardRelation:"unconditional",guardConditions:[],polarity:"positive",origin:[1],destination:[2],via:[[3]],bypass:[],extent:"whole",relation:"route"},operators:neutralBound,routeFrame:{entry:1,exit:2,route:0,exclusions:[],controls:[]}}];
  const before=JSON.stringify(f.wire),result=await f.schema.validate!(f.wire);
  expect(result.success).toBe(!outside);expect(JSON.stringify(f.wire)).toBe(before);
  if(result.success){expect(result.value.sources[0].facts[0].routeFrame?.entry).toEqual([0,3]);expect(result.value.sources[0].facts[0].routeFrame?.exit).toEqual([11,14]);}
});
it.each(["negative","reversed","fraction","outside","legacy_index","extra_quote"])("rejects invalid explicit basis ranges: %s",async mode=>{
  const f=keyedExample();
  if(mode==="negative")f.fact.basis[0].firstPart=-1;
  if(mode==="reversed"){f.fact.basis[0].firstPart=1;f.fact.basis[0].lastPart=0;}
  if(mode==="fraction")f.fact.basis[0].lastPart=0.5;
  if(mode==="outside")f.fact.basis[0].lastPart=100;
  if(mode==="legacy_index")Object.assign(f.fact,{basis:[7]});
  if(mode==="extra_quote")Object.assign(f.fact.basis[0],{quote:"装置"});
  expect((await f.schema.validate!(f.wire)).success).toBe(false);
});
it.each(["string_term","legacy_version","extra_binding","absent_term","oversize_term"])("rejects source bound terms: %s",async mode=>{
  if(mode==="oversize_term"){
    const f=boundExample("甲".repeat(81)+"。");f.row.locators=citations(citation("甲".repeat(81)));
    f.row.facts=[{basis:basis(),meaning:{kind:"relation",subject:null,context:"capability",guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"has",objects:[[0]]},operators:neutralBound,routeFrame:null}];
    expect((await f.schema.validate!(f.wire)).success).toBe(false);return;
  }
  const f=setup(),wire=fixturePropositionWire(f.source),fact=wire.sources[0].claims[0].facts[0];
  if(mode==="string_term")fact.meaning.subject="装置";
  if(mode==="legacy_version")wire.locatorVersion=1;
  if(mode==="extra_binding")fact.bindings=[];
  if(mode==="absent_term")fact.meaning.objects=[[999]];
  expect((await f.sourceSchema.validate!(wire)).success).toBe(false);
});
it("does not repair a fictional semantic term with its different binding",()=>{
  const f=setup(),fact=f.source.sources[0].facts[0];
  fact.bindings.find(b=>b.term===fact.meaning.subject)!.spans=fact.bindings.find(b=>b.term==="青色弁")!.spans;
  expect(()=>fixturePropositionWire(f.source)).toThrow("fictional_binding_changed");
});
it.each(["negative","reversed","fraction","outside","null_occurrence","outside_anchor","duplicate_position","old_v2"])("rejects invalid exact local part citation %s",async mode=>{
  const f=setup(),wire=fixturePropositionWire(f.source),row=wire.sources[0].claims[0],l=row.locators[0];
  if(mode==="negative")l.firstPart=-1;
  if(mode==="reversed"){l.firstPart=1;l.lastPart=0;}
  if(mode==="fraction")l.lastPart=0.5;
  if(mode==="outside")l.lastPart=1000;
  if(mode==="null_occurrence"){l.quote=null;l.occurrence=1;}
  if(mode==="outside_anchor")l.quote="隣接部分にしかない架空語";
  if(mode==="duplicate_position")row.locators.push({...l});
  if(mode==="old_v2")wire.locatorVersion=2;
  expect((await f.sourceSchema.validate!(wire)).success).toBe(false);
});
it("counts repeats within the selected part while keeping a separately selected full basis",async()=>{
  const text="甲".repeat(125)+"、装置は甲を備える。",f=boundExample(text),parts=f.input.sources[0].source.claims[0].segments;
  expect(parts.length).toBeGreaterThan(1);const last=parts.length-1,offset=parts.slice(0,last).reduce((n,p)=>n+p.text.length,0);
  f.row.locators=citations(citation("装置",0,last),citation("甲",0,last));
  f.row.facts=[{basis:basis(0,last),meaning:{kind:"relation",subject:[0],context:"capability",guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"has",objects:[[1]]},operators:neutralBound,routeFrame:null}];
  const result=await f.schema.validate!(f.wire);expect(result.success).toBe(true);
  if(result.success){const fact=result.value.sources[0].facts[0];expect(fact.basis).toEqual([[0,text.length]]);expect(fact.bindings.find(b=>b.term==="甲")!.spans[0][0]).toBe(offset+parts[last].text.indexOf("甲"));}
});
