import { expect, it } from "vitest";
import type { JSONSchema7 } from "ai";
import { fictionalClauseInputs as fictionalInputs } from "./source-clause-fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { decodeSourcePropositions, decodeTargetPropositions, propositionSourceInput, propositionSourceTransport,
  propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire } from "./proposition-fixtures.test-support";
import { resolvePropositionQuote, sourcePropositionModelSchemaFor, targetPropositionModelSchemaFor } from "./proposition-locators";

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
it("decodes the instructed sentence partition and exact nominal topic without absorbing a fact",async()=>{
  const f=setup(),t=f.targetInput.originals.targets.find(t=>t.id.endsWith(":unconfirmed"))!;
  const first="基準側は青色弁を備える。",topic="配置",last=topic+"は未確認。";
  t.text=first+last;t.unitStarts=[0,first.length];
  const proof=f.targetInput.sourcePropositions.find(p=>p.scope==="base:1"&&p.meaning.kind==="relation"&&p.meaning.predicate==="has")!;
  const answer=f.target.targets.find(a=>a.id===t.id)!;
  answer.parts=[{span:[0,first.length],form:"assertion",reference:null,reservation:null,atoms:[{
    basis:[[0,first.length]],bindings:[{term:"青色弁",spans:[[4,7]]}],
    meaning:{kind:"relation",subject:null,context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",predicate:"has",objects:["青色弁"]},
    operators:{selection:null,extent:null,polarity:null,guard:null,context:null},routeFrame:null,
    scope:"base:1",claimNo:1,sourceIds:[proof.id],attribution:[0,3],
  }]},{span:[first.length,t.text.length],form:"reservation",atoms:[],reference:null,
    reservation:{topic,basis:[first.length,first.length+topic.length]}}];
  const transport=propositionTargetTransport(f.targetInput),model=targetPropositionModelSchemaFor(f.targetInput);
  expect(transport.originals.targets.find(x=>x.id===t.id)!.unitStarts).toEqual([0,first.length]);
  const wire=fixturePropositionWire(f.target,transport),before=JSON.stringify(wire),result=await model.validate!(wire);
  expect(JSON.stringify(wire)).toBe(before);expect(result.success).toBe(true);
  if(!result.success)return;
  expect(decodeTargetPropositions(f.targetInput,result.value).atoms.some(a=>a.targetId===t.id)).toBe(true);
  const wrongTopic=structuredClone(result.value),wrong=wrongTopic.targets.find(x=>x.id===t.id)!.parts[1];
  wrong.reservation!.basis=wrong.span;
  expect(()=>decodeTargetPropositions(f.targetInput,wrongTopic)).toThrow("ai_incomplete");
  const crossing=structuredClone(result.value),parts=crossing.targets.find(x=>x.id===t.id)!;
  parts.parts=[{span:[0,t.text.length],form:"unresolved",atoms:[],reference:null,reservation:null}];
  expect(()=>decodeTargetPropositions(f.targetInput,crossing)).toThrow("ai_incomplete");
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
