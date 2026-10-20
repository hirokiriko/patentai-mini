import { expect, it } from "vitest";
import type { JSONSchema7 } from "ai";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { decodeSourcePropositions, decodeTargetPropositions, propositionSourceInput, propositionSourceTransport,
  propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire, fixtureCompactSource, fixtureExpandSource } from "./proposition-fixtures.test-support";
import { resolvePropositionQuote, sourcePropositionModelSchemaFor, targetPropositionModelSchemaFor } from "./proposition-locators";
import { parseComparisonSource } from "./source";
import { compactSourceWire, expandSourceWire } from "./source-wire-schema";
import { compareProposition } from "./propositions";

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
  const f=setup(),w=fixtureExpandSource(fixturePropositionWire(f.source)),s=w.sources[0].claims[0],fact=s.facts[0];
  if(mode==="legacy"){expect((await f.sourceSchema.validate!(f.source)).success).toBe(false);return;}
  if(mode==="mixed")fact.basis[0]=[0,1];
  if(mode==="absent_quote")fact.locators[0].quote="原文にない引用";
  if(mode==="unused")fact.locators.push({...fact.locators[0],quote:"備える"});
  if(mode==="duplicate_locator")fact.locators.push({...fact.locators[0]});
  if(mode==="negative_index")fact.meaning.subject=[-1];
  if(mode==="outside_index")fact.meaning.subject=[999];
  if(mode==="wrong_claim")s.claimNo=2;
  if(mode==="other_source")w.sources[0].sourceDigest=w.sources[1].sourceDigest;
  if(mode==="wrong_version")w.locatorVersion=0;
  expect((await f.sourceSchema.validate!(fixtureCompactSource(w))).success).toBe(false);
});

function boundExample(text:string,second?:string) {
  const f=fictionalInputs();f.inputs.draft=parseComparisonSource("【請求項1】\n"+text+(second?"\n【請求項2】\n"+second:""),11,"draft-11");
  if(second)f.selection.draftClaimNos=[1,2];
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire={locatorVersion:8,sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,claims:s.source.claims.map(c=>({
    claimNo:c.claimNo,requiredLoops:[],facts:[] as unknown[]}))}))};
  const model=sourcePropositionModelSchemaFor(plan);
  return {model,validate:(value:unknown)=>model.validate!(fixtureCompactSource(value)),wire,row:wire.sources[0].claims[0],plan,input};
}
const neutralBound={selection:null,extent:null,polarity:null,guard:null,context:null};
const citation=(quote:string|null,occurrence=0)=>({quote,occurrence});
const basis=(firstPart=0,lastPart=firstPart)=>({firstPart,lastPart});
function keyedExample(){
  const f=boundExample("装置は青色弁を備える。");
  const fact={basis:basis(),locators:[citation("装置"),citation("青色弁")],
    meaning:{kind:"relation",subject:[0],context:"capability",guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"has",objects:[[1]]},
    operators:{...neutralBound},routeFrame:null};
  f.row.facts=[fact];return {...f,fact};
}
it("uses source-only short spelling, preserving all values and rejecting mixed keys",async()=>{
  const f=keyedExample(),wire=compactSourceWire(f.wire),before=JSON.stringify(wire);
  expect(wire).toEqual(fixtureCompactSource(f.wire));
  expect(expandSourceWire(wire)).toEqual(f.wire);
  expect((await f.model.validate!(wire)).success).toBe(true);
  expect(JSON.stringify(wire)).toBe(before);
  expect((await f.model.validate!({...wire as object,locatorVersion:8})).success).toBe(false);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("each fact resolves its own array, even when another fact reuses those indexes",async()=>{
  const f=keyedExample(),other=structuredClone(f.fact);
  other.locators.reverse();other.meaning.subject=[1];other.meaning.objects=[[0]];
  f.row.facts.push(other);
  const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0]).toEqual(r.value.sources[0].facts[1]);
});
it.each(["absent","negative","fraction","outside","unused","duplicate","null_occurrence","legacy_id","legacy_basis_index"])("rejects fact-local locator error %s",async mode=>{
  const f=keyedExample(),l=f.fact.locators[0];
  if(mode==="absent")l.quote="存在しない名";
  if(mode==="negative")l.occurrence=-1;
  if(mode==="fraction")l.occurrence=0.5;
  if(mode==="outside")l.occurrence=12;
  if(mode==="unused")f.fact.locators.push(citation("備える"));
  if(mode==="duplicate")f.fact.locators.push({...l});
  if(mode==="null_occurrence"){l.quote=null;l.occurrence=1;}
  if(mode==="legacy_id")Object.assign(l,{id:0});
  if(mode==="legacy_basis_index")Object.assign(l,{basisIndex:0});
  const before=JSON.stringify(f.wire);
  expect((await f.validate(f.wire)).success).toBe(false);expect(JSON.stringify(f.wire)).toBe(before);
});
it.each(["missing","duplicate","reordered","borrowed_quote","foreign_claim_field"])("rejects incomplete or borrowed claim readings %s",async mode=>{
  const f=boundExample("装置は青色弁を備える。","機器は赤色弁を備える。"),claims=f.wire.sources[0].claims;
  if(mode==="missing")claims.pop();
  if(mode==="duplicate")claims[1]=structuredClone(claims[0]);
  if(mode==="reordered")claims.reverse();
  if(mode==="borrowed_quote")claims[1].facts=[keyedExample().fact];
  if(mode==="foreign_claim_field")claims[1].facts=[{...keyedExample().fact,claimNo:1}];
  expect((await f.validate(f.wire)).success).toBe(false);
});
it("retains canonical-only claims without claiming complete semantic coverage",async()=>{
  const f=boundExample("前記第１の運転モードは紫色モードであり、装置を作動させる。"),r=await f.validate(f.wire);
  expect(r.success).toBe(true);
  if(r.success)expect(decodeSourcePropositions(f.plan,r.value).facts.some(f=>f.authority==="literal")).toBe(true);
});
it.each([false,true])("distinguishes a supplied canonical set from other actions, conditional=%s",async conditional=>{
  const f=boundExample(`前記第１の運転モードは紫色モードであり、装置は${conditional?"温度が七度を超える場合に":""}青色弁を開く。`);
  const claim=propositionSourceTransport(f.input).sources[0].source.claims[0];
  expect(claim.canonicalModeSets).toEqual(conditional?[]:[{subject:"第１の運転モード",selection:"required",extent:"closed",members:["紫色モード"]}]);
  const fact=keyedExample().fact;fact.basis=basis(0,claim.parts.length-1);
  fact.locators=[citation("装置"),citation("青色弁")];
  Object.assign(fact.meaning,{predicate:"opens",context:"operation"});
  if(conditional){
    fact.locators.push(citation("温度が七度を超える場合"));
    Object.assign(fact.meaning,{guardRelation:"when",guardConditions:[[2]]});
    Object.assign(fact.operators,{guard:2});
  }
  f.row.facts=[fact];
  const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(!r.success)return;
  const complete=decodeSourcePropositions(f.plan,r.value),action=complete.facts.find(p=>p.authority==="extracted")!;
  expect(action.meaning).toMatchObject({kind:"relation",predicate:"opens",guard:conditional?
    {relation:"when",conditions:["温度が七度を超える場合"]}:{relation:"unconditional",conditions:[]}});
  expect(complete.facts.some(p=>p.authority==="literal"&&p.meaning.kind==="set")).toBe(!conditional);
  const t={id:"target",targetId:"statement",span:[0,1] as [number,number],scope:action.scope,claimNo:action.claimNo,
    meaning:action.meaning,sourceIds:[action.id]};
  expect(compareProposition(t,complete.facts).relation).toBe("entailed");
  f.row.facts=[];const empty=await f.validate(f.wire);expect(empty.success).toBe(true);
  if(empty.success)expect(compareProposition(t,decodeSourcePropositions(f.plan,empty.value).facts).relation).toBe("unresolved");
});
it.each([7,6])("rejects an old source wire version without repairing it: %s",async version=>{
  const f=keyedExample(),wire={...f.wire,locatorVersion:version},before=JSON.stringify(wire);
  expect((await f.validate(wire)).success).toBe(false);expect(JSON.stringify(wire)).toBe(before);
});
it.each(["negative","reversed","fraction","outside","legacy","split_ranges","extra"])("rejects malformed chosen basis %s",async mode=>{
  const f=keyedExample(),b=f.fact.basis;
  if(mode==="negative")b.firstPart=-1;
  if(mode==="reversed"){b.firstPart=1;b.lastPart=0;}
  if(mode==="fraction")b.lastPart=0.5;
  if(mode==="outside")b.lastPart=100;
  if(mode==="legacy")Object.assign(f.fact,{basis:[0]});
  if(mode==="split_ranges")Object.assign(f.fact,{basis:[{...b},{...b}]});
  if(mode==="extra")Object.assign(b,{quote:"装置"});
  expect((await f.validate(f.wire)).success).toBe(false);
});
it("counts occurrences in one selected range and never concatenates separate ranges",async()=>{
  const f=boundExample("甲".repeat(125)+"、装置は甲を備える。"),parts=f.input.sources[0].source.claims[0].segments,last=parts.length-1;
  const fact=keyedExample().fact;fact.basis=basis(last);fact.locators=[citation("装置"),citation("甲")];f.row.facts=[fact];
  const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(r.success){const offset=parts.slice(0,last).reduce((n,p)=>n+p.text.length,0);
    expect(r.value.sources[0].facts[0].bindings.find(b=>b.term==="甲")!.spans[0][0]).toBe(offset+parts[last].text.indexOf("甲"));}
  Object.assign(fact,{basis:[{firstPart:0,lastPart:0},{firstPart:last,lastPart:last}]});
  fact.locators[0]=citation(parts[0].text+parts[last].text);
  expect((await f.validate(f.wire)).success).toBe(false);
});
it("does not widen a basis to find a noun at a different occurrence",async()=>{
  const f=boundExample("装置は青色弁を備える、"+"甲".repeat(150)+"、別の赤色弁。"),fact=keyedExample().fact;
  fact.locators[1].quote="赤色弁";f.row.facts=[fact];
  expect((await f.validate(f.wire)).success).toBe(false);
});
it("composes only exact printed fragments, never a corrected semantic term",async()=>{
  const f=boundExample("第１、第２運転モードを備える。"),fact=keyedExample().fact;
  fact.locators=[citation("第１"),citation("運転モード")];Object.assign(fact.meaning,{subject:null,objects:[[0,1]]});f.row.facts=[fact];
  const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].bindings).toEqual([{term:"第１運転モード",spans:[[0,2],[5,10]]}]);
  const g=setup(),source=g.source.sources[0].facts[0];
  source.bindings.find(b=>b.term===source.meaning.subject)!.spans=source.bindings.find(b=>b.term==="青色弁")!.spans;
  expect(()=>fixturePropositionWire(g.source)).toThrow("fictional_binding_changed");
});
it.each(["string","too_long","missing","foreign_binding"])("retains strict semantic term checks %s",async mode=>{
  const f=keyedExample();
  if(mode==="string")Object.assign(f.fact.meaning,{subject:"装置"});
  if(mode==="missing")f.fact.meaning.objects=[[99]];
  if(mode==="foreign_binding")Object.assign(f.fact,{bindings:[]});
  if(mode==="too_long"){
    const g=boundExample("甲".repeat(81)+"。");f.fact.locators=[citation("甲".repeat(81))];
    Object.assign(f.fact.meaning,{subject:null,objects:[[0]]});g.row.facts=[f.fact];
    expect((await g.validate(g.wire)).success).toBe(false);return;
  }
  expect((await f.validate(f.wire)).success).toBe(false);
});
it.each(["guard","negative"])("does not invent omitted %s evidence",async mode=>{
  const text="装置は温度が七度を超える場合に青色弁を開かない。",f=boundExample(text),fact=keyedExample().fact;
  fact.locators.push(citation("温度が七度を超える"),citation("開かない"));
  Object.assign(fact.meaning,{predicate:"opens",guardRelation:"when",guardConditions:[[2]],polarity:"negative"});
  Object.assign(fact.operators,{guard:mode==="guard"?null:2,polarity:mode==="negative"?null:3});
  // Keep all locators used while testing the domain evidence requirement.
  if(mode==="guard")Object.assign(fact.operators,{context:2});
  if(mode==="negative")Object.assign(fact.operators,{context:3});
  f.row.facts=[fact];const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
});
it("keeps a complete long AND trigger while encoding its exact bounded condition terms",async()=>{
  const conditions=["第一温度計が示す温度が制御開始時に記録した基準温度よりも高い",
    "第二圧力計が示す圧力が制御開始時に記録した基準圧力よりも低い",
    "第三流量計が示す流量が制御開始時に記録した基準流量よりも多い"];
  const trigger=conditions.join("かつ")+"場合",text=`装置は${trigger}に青色弁を開く。`,f=boundExample(text),fact=keyedExample().fact;
  expect(trigger.length).toBeGreaterThan(80);expect(conditions.every(c=>c.length<=80)).toBe(true);
  fact.basis=basis(0,propositionSourceTransport(f.input).sources[0].source.claims[0].parts.length-1);
  fact.locators.push(...conditions.map(c=>citation(c)),citation(trigger));
  Object.assign(fact.meaning,{predicate:"opens",guardRelation:"when",guardConditions:[[2],[3],[4]]});
  Object.assign(fact.operators,{guard:5});f.row.facts=[fact];
  const r=await f.validate(f.wire);expect(r.success).toBe(true);
  if(r.success){
    expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
    const raw=r.value.sources[0].facts[0];
    expect(raw.meaning.guard.conditions).toEqual(conditions);
    expect(text.slice(...raw.operators.guard!)).toBe(trigger);
  }
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
    expect(root.properties).toHaveProperty(schema===f.sourceSchema?"v":"locatorVersion");
    expect(JSON.stringify(root)).not.toContain("oneOf");
  }
});
it.each([[0,1.5],[0,-1],[0,1,2]])("does not silently repair invalid numeric coordinates in a fictional answer: %j",(...range)=>{
  const f=setup();
  Object.assign(f.source.sources[0].facts[0],{basis:[range]});
  expect(()=>fixturePropositionWire(f.source)).toThrow("fictional_locator_invalid");
});
it.each(["binding","operator","frame"])("rejects fractional/extra coordinates before fictional %s encoding",field=>{
  for(const range of [[0,1.5],[0,1,999],[-1,2],[2,1]]){
    const f=setup(),fact=f.source.sources[0].facts[0];
    if(field==="binding")Object.assign(fact.bindings[0],{spans:[range]});
    if(field==="operator")Object.assign(fact.operators,{context:range});
    if(field==="frame")Object.assign(fact,{routeFrame:{entry:range,exit:[0,1],route:[0,1],exclusions:[],controls:[]}});
    expect(()=>fixturePropositionWire(f.source)).toThrow("fictional_locator_invalid");
  }
});
