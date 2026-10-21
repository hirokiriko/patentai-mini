import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { decodeSourcePropositions, propositionSourceInput, propositionSourceTransport } from "./proposition-extraction";
import { sourcePropositionModelSchemaFor } from "./proposition-locators";
import { resolveSourceContextQuote } from "./source-direct-quotes";
import { compareProposition } from "./propositions";
import { SOURCE_ACTION_TEXT,SOURCE_ACTION_FACTS } from "./source-worked-example";
import { fixtureRequiredSourceWire,fixturePropositionWire } from "../../../scripts/prior-art-proposition-fixture.mjs";

const q=(quote:string,context:string|null=null)=>{
  const at=context?.indexOf(quote)??0;
  return {quote,before:context?.slice(0,at)??"",after:context?.slice(at+quote.length)??"",edge:"none" as const};
};
function setup(text="装置は青色弁を備える。",second?:string) {
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】"+text+(second?"\n【請求項2】"+second:""),11,"架空");
  f.selection.draftClaimNos=second?[1,2]:[1];
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire=JSON.parse(JSON.stringify({locatorVersion:12,sources:input.sources.map(s=>({
    sourceDigest:s.sourceDigest,...Object.fromEntries(s.source.claims.map(c=>[`c${c.claimNo}`,
      {quote:c.segments.map(p=>p.text).join(""),before:"",after:"",edge:"none",reason:"No additional fact supplied in this fictional test."}])),
  }))}));
  const fact={
    meaning:{kind:"relation",subject:[q("装置")],context:"capability",guardRelation:"unconditional",guardConditions:[],
      polarity:"positive",predicate:"has",objects:[[q("青色弁")]]},
    operators:{selection:null,extent:null,polarity:null,guard:null,context:null},routeFrame:null};
  wire.sources[0].c1=[fact];
  return {plan,input,wire,fact,model:sourcePropositionModelSchemaFor(plan)};
}
it("binds every direct role without altering raw or adding source facts from coverage",async()=>{
  const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
  expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);
  if(r.success){
    expect(r.value.sources[0].facts[0].bindings).toEqual([{term:"装置",spans:[[0,2]]},{term:"青色弁",spans:[[3,6]]}]);
    expect(r.value.sources[1].facts).toEqual([]);
    expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
  }
});
it("does not let the fictional encoder discard a foreign claim",()=>{
  const f=setup();
  expect(()=>fixtureRequiredSourceWire({sources:[{sourceDigest:f.wire.sources[0].sourceDigest,
    coverage:[{claimNo:1,unresolved:null}],facts:[{...f.fact,claimNo:99}]}]})).toThrow("fictional_foreign_claim");
});
it.each(["binding","operator","frame"])("does not widen invalid fictional internal evidence: %s",async kind=>{
  const f=setup("装置は青色弁を備える。"+"甲".repeat(125)+"、赤色弁を備える。"),r=await f.model.validate!(f.wire);
  expect(r.success).toBe(true);if(!r.success)return;
  const claim=f.input.sources[0].source.claims[0],text=claim.segments.map(p=>p.text).join("");
  const at=text.indexOf("赤色弁"),outside:[number,number]=[at,at+3],fact=r.value.sources[0].facts[0];
  fact.basis=[[0,claim.segments[0].text.length]];
  if(kind==="binding"){fact.meaning={...fact.meaning,kind:"relation",predicate:"has",objects:["赤色弁"]};fact.bindings=[{term:"装置",spans:[[0,2]]},{term:"赤色弁",spans:[outside]}];}
  if(kind==="operator")fact.operators.guard=outside;
  if(kind==="frame")fact.routeFrame={entry:outside,exit:outside,route:outside,exclusions:[],controls:[]};
  const before=JSON.stringify(r.value);
  expect(()=>fixturePropositionWire(r.value,propositionSourceTransport(f.input))).toThrow("fictional_locator_outside_basis");
  expect(JSON.stringify(r.value)).toBe(before);
});
it.each(["missing","foreign","legacy_array","empty_array","old_v11","empty_reason","whitespace_reason","missing_quote","absent_quote",
  "zero_without_reason","fact_with_reason"])("rejects incomplete claim accounting: %s",async mode=>{
  const f=setup("装置は青色弁を備える。","機器は赤色弁を備える。"),c=f.wire.sources[0];
  if(mode==="missing")delete c.c2;
  if(mode==="foreign"){c.c3=c.c2;delete c.c2;}
  if(mode==="legacy_array")f.wire.sources[0].coverage=[{claimNo:1,unresolved:null},{claimNo:2,unresolved:c.c2}];
  if(mode==="empty_array")c.c2=[];
  if(mode==="old_v11")f.wire.locatorVersion=11;
  if(mode==="empty_reason")c.c2.reason="";
  if(mode==="whitespace_reason")c.c2.reason=" \n ";
  if(mode==="missing_quote")delete c.c2.quote;
  if(mode==="absent_quote")c.c2.quote="別の原文";
  if(mode==="zero_without_reason")c.c2=null;
  if(mode==="fact_with_reason")c.c1={facts:c.c1,...structuredClone(c.c2)};
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("enforces the source total across separate claim answers",async()=>{
  const f=setup("装置は青色弁を備える。","装置は青色弁を備える。");
  Object.assign(f.fact,{operators:null});
  f.wire.sources[0].c1=Array.from({length:24},()=>structuredClone(f.fact));
  f.wire.sources[0].c2=Array.from({length:24},()=>structuredClone(f.fact));
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.wire.sources[0].c2.push(structuredClone(f.fact));
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["absent","legacy_occurrence","missing_before","ambiguous","old_index","old_table","old_version","other_source","foreign_claim",
  "wrong_basis","split_basis","reverse_basis","extra_basis","too_long_term","term_fragments_over80"])("rejects invalid direct evidence: %s",async mode=>{
  const f=setup(),a=f.fact;
  if(mode==="absent")a.meaning.objects[0][0].quote="別の弁";
  if(mode==="legacy_occurrence")Object.assign(a.meaning.objects[0][0],{occurrence:0});
  if(mode==="missing_before")delete (a.meaning.objects[0][0] as {before?:string|null}).before;
  if(mode==="ambiguous")a.meaning.objects[0][0].after="別の原文";
  if(mode==="old_index")Object.assign(a.meaning,{objects:[[0]]});
  if(mode==="old_table")Object.assign(a,{locators:[q("青色弁")]});
  if(mode==="old_version")f.wire.locatorVersion=9;
  if(mode==="other_source")f.wire.sources[0].sourceDigest=f.wire.sources[1].sourceDigest;
  if(mode==="foreign_claim")Object.assign(a,{claimNo:2});
  if(mode==="wrong_basis")Object.assign(a,{basis:{firstPart:0,lastPart:99}});
  if(mode==="split_basis")Object.assign(a,{basis:[{firstPart:0,lastPart:0}]});
  if(mode==="reverse_basis")Object.assign(a,{basis:{firstPart:1,lastPart:0}});
  if(mode==="extra_basis")Object.assign(a,{basis:{quote:"装置"}});
  if(mode==="too_long_term"||mode==="term_fragments_over80"){
    const g=setup("甲".repeat(81)+"。");Object.assign(g.fact.meaning,{subject:null,objects:
      mode==="too_long_term"?[[q("甲".repeat(81))]]:[[q("甲".repeat(41)),q("甲".repeat(40))]]});
    expect((await g.model.validate!(g.wire)).success).toBe(false);return;
  }
  const before=JSON.stringify(f.wire);expect((await f.model.validate!(f.wire)).success).toBe(false);
  expect(JSON.stringify(f.wire)).toBe(before);
});
it("validates a repeated term at every role before coalescing identical binding text",async()=>{
  const f=setup();f.fact.meaning.objects=[[q("装置")]];
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.fact.meaning.objects[0][0].after="存在しない文脈";
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("resolves contextual quotes across storage parts without treating a part as a clause",async()=>{
  const f=setup("甲".repeat(125)+"、装置は甲を備える。"),parts=f.input.sources[0].source.claims[0].segments,last=parts.length-1;
  f.fact.meaning.objects=[[q("甲","装置は甲を備える")]];
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].bindings.find(b=>b.term==="甲")!.spans[0][0])
    .toBe(parts.map(p=>p.text).join("").lastIndexOf("甲"));
  Object.assign(f.fact,{basis:{firstPart:last,lastPart:last}});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("composes exact printed fragments, including a shared suffix",async()=>{
  const f=setup("第１、第２運転モードを備える。");
  Object.assign(f.fact.meaning,{subject:null,objects:[[q("第１"),q("運転モード")]]});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].bindings).toEqual([{term:"第１運転モード",spans:[[0,2],[5,10]]}]);
});
it.each(["guard","negative"])("keeps domain evidence requirements for %s",async mode=>{
  const f=setup("装置は温度が七度を超える場合に青色弁を開かない。");
  Object.assign(f.fact.meaning,{predicate:"opens",context:"operation",guardRelation:"when",
    guardConditions:[[q("温度が七度を超える場合")]],polarity:"negative"});
  Object.assign(f.fact.operators,{guard:mode==="guard"?null:q("温度が七度を超える場合"),
    polarity:mode==="negative"?null:q("開かない")});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
});
it("keeps the full long AND guard while each condition term is bounded",async()=>{
  const cs=["第一温度計が示す温度が制御開始時に記録した基準温度よりも高い",
    "第二圧力計が示す圧力が制御開始時に記録した基準圧力よりも低い",
    "第三流量計が示す流量が制御開始時に記録した基準流量よりも多い"];
  const trigger=cs.join("かつ")+"場合",f=setup(`装置は${trigger}に青色弁を開く。`);
  Object.assign(f.fact.meaning,{predicate:"opens",context:"operation",guardRelation:"when",guardConditions:cs.map(c=>[q(c)])});
  Object.assign(f.fact.operators,{guard:q(trigger)});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success){expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();expect(r.value.sources[0].facts[0].meaning.guard.conditions).toEqual(cs);}
});
it("decodes guarded opposite actions without replacing them by a set",async()=>{
  const f=setup(SOURCE_ACTION_TEXT);f.wire.sources[0].c1=structuredClone(SOURCE_ACTION_FACTS);
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  const result=decodeSourcePropositions(f.plan,r.value),own=result.facts.filter(s=>s.id.startsWith("s0."));
  expect(own.map(p=>p.meaning)).toMatchObject([
    {kind:"relation",predicate:"opens",objects:["赤色弁"],polarity:"positive"},
    {kind:"relation",predicate:"closes",objects:["青色弁"],polarity:"positive"}]);
  const p=own[0],target={id:"action",targetId:"action",span:[0,1]as [number,number],scope:p.scope,claimNo:1,sourceIds:[p.id],meaning:p.meaning};
  expect(compareProposition(target,result.facts).relation).toBe("entailed");
  expect(compareProposition(target,result.facts.filter(s=>s.id!==p.id)).relation).toBe("unresolved");
});
it("does not turn explicit unresolved coverage into evidence for an omitted action",async()=>{
  const f=setup(),r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  const prior=decodeSourcePropositions(f.plan,r.value),p=prior.facts.find(s=>s.id.startsWith("s0."))!;
  f.wire.sources[0].c1={quote:"装置は青色弁を備える。",before:"",after:"",edge:"none",reason:"Fixture intentionally withholds the extraction."};
  const empty=await f.model.validate!(f.wire);expect(empty.success).toBe(true);if(!empty.success)return;
  const target={id:"t",targetId:"t",span:[0,1]as [number,number],scope:p.scope,claimNo:1,sourceIds:[p.id],meaning:p.meaning};
  expect(compareProposition(target,decodeSourcePropositions(f.plan,empty.value).facts).relation).toBe("unresolved");
});
it("extracts an own-clause placement under alternative parents without merging their facts",async()=>{
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】装置は赤弁を備える。\n【請求項2】装置は青弁を備える。\n【請求項3】ヒータは筐体内にある請求項1又は2に記載の装置。",11,"架空");
  f.selection.draftClaimNos=[3];
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire={locatorVersion:12,sources:input.sources.map((s,i)=>({sourceDigest:s.sourceDigest,
    ...Object.fromEntries(s.source.claims.map(c=>[`c${c.claimNo}`,i===0&&c.claimNo===3?[{
      meaning:{kind:"relation",subject:[q("ヒータ")],context:"capability",guardRelation:"unconditional",guardConditions:[],polarity:"positive",predicate:"inside",objects:[[q("筐体")]]},
      operators:null,routeFrame:null}]:
      {quote:c.segments.map(p=>p.text).join(""),before:"",after:"",edge:"none",reason:"Fixture withholds this independent context reading."}])),
  }))};
  const before=JSON.stringify(wire),decoded=await sourcePropositionModelSchemaFor(plan).validate!(wire);
  expect(decoded.success).toBe(true);expect(JSON.stringify(wire)).toBe(before);if(!decoded.success)return;
  const result=decodeSourcePropositions(plan,decoded.value),own=result.facts.filter(p=>p.authority==="extracted");
  expect(own).toHaveLength(1);expect(own[0]).toMatchObject({claimNo:3,meaning:{predicate:"inside",subject:"ヒータ",objects:["筐体"]}});
  const node=result.input.sources[0].scopes[0].nodes.find(n=>n.claimNo===3)!;
  expect(node.guaranteed).not.toContain(1);expect(node.guaranteed).not.toContain(2);
  expect(compareProposition({id:"t",targetId:"t",span:[0,1],scope:own[0].scope,claimNo:3,sourceIds:[own[0].id],meaning:own[0].meaning},own).relation).toBe("entailed");
});
it("enforces 32000 UTF8 bytes on otherwise valid v12 facts",async()=>{
  const f=setup("装置は青色弁を備える。"+"x".repeat(6_000)+"。");
  const row={...f.fact,operators:{...f.fact.operators,guard:q("装置","装置は青色弁を備える。"+"x".repeat(200))}};
  const bytes=()=>Buffer.byteLength(JSON.stringify(f.wire));
  let found=false;
  for(let n=1;n<=48;n++){
    f.wire.sources[0].c1=Array.from({length:n},()=>structuredClone(row));
    const last=f.wire.sources[0].c1[n-1];
    last.operators.guard=q("装置","装置は青色弁を備える。");
    const remaining=31_999-bytes();
    if(remaining>=0&&remaining+3<=6_000){
      last.operators.guard=q("装置","装置は青色弁を備える。"+"x".repeat(remaining));found=true;break;
    }
  }
  expect(found).toBe(true);expect(bytes()).toBe(31_999);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  const last=f.wire.sources[0].c1.at(-1);
  last.operators.guard.after+="x";
  expect(bytes()).toBe(32_000);expect((await f.model.validate!(f.wire)).success).toBe(true);
  last.operators.guard.after+="x";
  expect(bytes()).toBe(32_001);expect((await f.model.validate!(f.wire)).success).toBe(false);
  expect((await f.model.validate!({v:8,ss:[]})).success).toBe(false);
});
it.each(["unique","absent","repeated","overlap","surrogate"])("requires explicit adjacent context and rejects absent or split quotes: %s",async mode=>{
  const text=mode==="repeated"?"装置は青色弁と青色弁を備える。":
    mode==="overlap"?"装置はあああを備える。":mode==="surrogate"?"装置は😀を備える。":"装置は青色弁を備える。";
  const f=setup(text),literal=mode==="absent"?"別の弁":mode==="overlap"?"ああ":mode==="surrogate"?"\ud83d":"青色弁";
  Object.assign(f.fact.meaning,{subject:["装置"],objects:[[literal]]});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  Object.assign(f.fact.meaning,{subject:[q("装置")],objects:[[q(literal,mode==="repeated"?"と青色弁を":mode==="overlap"?"あああ":null)]]});
  expect((await f.model.validate!(f.wire)).success).toBe(!["absent","surrogate"].includes(mode));
});
it("round-trips null operators as five nulls without changing meaning or accepting missing guard/polarity proof",async()=>{
  const f=setup(),full=await f.model.validate!(f.wire);
  Object.assign(f.fact,{operators:null});
  const abbreviated=await f.model.validate!(f.wire);
  expect(abbreviated).toEqual(full);
  for(const mode of ["guard","negative"]){
    const g=setup("装置は温度が七度を超える場合に青色弁を開かない。");
    Object.assign(g.fact,{operators:null});
    Object.assign(g.fact.meaning,{predicate:"opens",context:"operation",guardRelation:mode==="guard"?"when":"unconditional",
      guardConditions:mode==="guard"?[[q("温度が七度を超える場合")]]:[],polarity:mode==="negative"?"negative":"positive"});
    const r=await g.model.validate!(g.wire);expect(r.success).toBe(true);
    if(r.success)expect(()=>decodeSourcePropositions(g.plan,r.value)).toThrow("ai_incomplete");
  }
});
it.each(["operator_string","missing_key","extra_key","composed_guard"])("rejects incomplete or synthesized evidence: %s",async mode=>{
  const f=setup(SOURCE_ACTION_TEXT);f.wire.sources[0].c1=structuredClone(SOURCE_ACTION_FACTS);
  const a=f.wire.sources[0].c1[0];
  if(mode==="operator_string")a.operators.guard="前記通電状態で温度が七度を超える場合";
  if(mode==="missing_key")delete a.operators.context;
  if(mode==="extra_key")a.operators.invented=null;
  if(mode==="composed_guard")a.operators.guard=q("通電状態で前記温度が七度を超える場合");
  const before=JSON.stringify(f.wire);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  expect(JSON.stringify(f.wire)).toBe(before);
});
it("binds a subject and object across parts in the same complete claim, rejecting foreign text",async()=>{
  const f=setup("装置は"+"甲".repeat(125)+"、青色弁を備える。");
  const parts=f.input.sources[0].source.claims[0].segments,last=parts.length-1;
  expect(last).toBeGreaterThan(0);
  expect(parts[last].text).toContain("青色弁");expect(parts[last].text).not.toContain("装置");
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.fact.meaning.subject[0].quote="他請求項の装置";
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("allows only operator/frame evidence to name the already selected whole basis",async()=>{
  const f=setup();Object.assign(f.fact.operators,{guard:{quote:null,before:"",after:"",edge:"both"}});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].operators.guard).toEqual(r.value.sources[0].facts[0].basis[0]);
  Object.assign(f.fact.operators,{guard:{quote:null,before:"装置",after:"",edge:"both"}});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  Object.assign(f.fact.operators,{guard:null});
  Object.assign(f.fact.meaning,{objects:[[{quote:null,before:"",after:"",edge:"both"}]]});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["送出器","予備送出器"])("checks exact component equivalence in manual route frames: %s",async inlet=>{
  const route=`流体は${inlet}から受入器へ流れる。`,f=setup(`前記送出器を備える。${route}`);
  Object.assign(f.fact,{meaning:{kind:"path",subject:null,context:"operation",guardRelation:"unconditional",
    guardConditions:[],polarity:"positive",origin:[q("前記送出器")],destination:[q("受入器")],via:[],bypass:[],
    extent:"whole",relation:"route"},
    routeFrame:{entry:q(inlet,route),exit:q("受入器"),route:q(route),exclusions:[],controls:[]}});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  if(inlet==="送出器")expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
  else expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
});
it("rejects a dynamic schema beyond Azure's 100 properties without dropping ancestor claims",()=>{
  const f=fictionalInputs();
  const text=Array.from({length:45},(_,i)=>`【請求項${i+1}】${i?`請求項${i}に記載の装置であって、`:""}青色弁を備える。`).join("\n");
  f.inputs.draft=parseComparisonSource(text,11,"架空");
  f.selection.draftClaimNos=[45];
  const plan=makePlan(f.inputs,f.selection);
  expect(propositionSourceInput(plan).sources[0].source.claims).toHaveLength(45);
  expect(()=>sourcePropositionModelSchemaFor(plan)).toThrow("plan_limit");
  expect(propositionSourceInput(plan).sources[0].source.claims).toHaveLength(45);
});

// Fictional repeated valve conditions: an exact substring alone is not enough.
const valveText="青色弁は通電状態で閉じ、非通電状態で開く。赤色弁は通電状態で開き、非通電状態で閉じる。";
function guardedValve(condition="通電状態",context="赤色弁は通電状態で開き") {
  const f=setup(valveText);
  Object.assign(f.fact.meaning,{subject:null,context:"capability",predicate:"opens",objects:[[q("赤色弁")]],
    guardRelation:"when",guardConditions:[[q(condition,context)]]});
  Object.assign(f.fact.operators,{guard:q(condition,context)});
  return f;
}
it("binds the affirmative condition to the explicitly quoted second-valve context without changing raw",async()=>{
  const f=guardedValve(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
  expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);if(!r.success)return;
  const at=valveText.indexOf("通電状態",valveText.indexOf("赤色弁")),fact=r.value.sources[0].facts[0];
  expect(fact.bindings.find(b=>b.term==="通電状態")!.spans).toEqual([[at,at+4]]);
  expect(fact.operators.guard).toEqual([at,at+4]);
  expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
});
it.each(["negative_prefix","whole_claim_proof","wrong_guard","ambiguous_context","ambiguous_quote","absent_context"])(
  "rejects a misplaced or ambiguous condition without repairing it: %s",async mode=>{
    const f=guardedValve();
    if(mode==="negative_prefix"||mode==="whole_claim_proof"){
      Object.assign(f.fact.meaning,{guardConditions:[[q("通電状態","非通電状態で開く")]]});
      Object.assign(f.fact.operators,{guard:mode==="whole_claim_proof"?{quote:null,before:"",after:"",edge:"both"}:q("通電状態","非通電状態で開く")});
    }
    if(mode==="wrong_guard")Object.assign(f.fact.operators,{guard:q("通電状態","青色弁は通電状態で閉じ")});
    if(mode==="ambiguous_context")Object.assign(f.fact.meaning,{guardConditions:[[q("通電状態","非通電状態")]]});
    if(mode==="ambiguous_quote")Object.assign(f.fact.meaning,{guardConditions:[[q("通電状態",valveText)]]});
    if(mode==="absent_context")Object.assign(f.fact.meaning,{guardConditions:[[q("通電状態","赤色弁は通電状態で閉じ")]]});
    const before=JSON.stringify(f.wire);
    expect((await f.model.validate!(f.wire)).success).toBe(false);
    expect(JSON.stringify(f.wire)).toBe(before);
  });
it.each(["前記","当該","該",""])("permits only a complete demonstrative omission from a condition: %s",async prefix=>{
  const f=setup(`装置は${prefix}通電状態で青色弁を開く。`);
  Object.assign(f.fact.meaning,{predicate:"opens",guardRelation:"when",guardConditions:[[q("通電状態")]]});
  Object.assign(f.fact.operators,{guard:q(prefix+"通電状態")});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
});
it.each(["非","不","未","無","非前記","𠀀"])("does not discard the condition's Han prefix: %s",async prefix=>{
  const f=setup(`装置は${prefix}通電状態で青色弁を閉じる。`);
  Object.assign(f.fact.meaning,{predicate:"closes",guardRelation:"when",guardConditions:[[q("通電状態")]]});
  Object.assign(f.fact.operators,{guard:q(prefix+"通電状態")});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each([false,true])("keeps a complete negative condition including adjacent fragments: %s",async split=>{
  const f=setup("装置は非通電状態で青色弁を閉じる。");
  Object.assign(f.fact.meaning,{predicate:"closes",guardRelation:"when",
    guardConditions:[split?[q("非"),q("通電状態")]:[q("非通電状態")]]});
  Object.assign(f.fact.operators,{guard:q("非通電状態")});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  expect(r.value.sources[0].facts[0].meaning.guard.conditions).toEqual(["非通電状態"]);
  expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
});
it("rejects a condition with its Han suffix removed",async()=>{
  const f=setup("装置は非通電状態で青色弁を閉じる。");
  Object.assign(f.fact.meaning,{predicate:"closes",guardRelation:"when",guardConditions:[[q("非通電")]]});
  Object.assign(f.fact.operators,{guard:q("非通電状態")});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["context","quote"])("rejects a UTF16 surrogate split in %s",async mode=>{
  const f=setup("装置は😀青色弁を備える。");
  f.fact.meaning.objects=[[mode==="context"?q("青色弁","\ude00青色弁"):q("\ud83d","😀青色弁")]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("keeps the fictional context encoder on complete UTF16 characters",async()=>{
  const f=setup("装置は😀青色弁。😁青色弁。");
  f.fact.meaning.objects=[[q("青色弁","😁青色弁")]];
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  const encoded=fixturePropositionWire(r.value,propositionSourceTransport(f.input));
  const replay=await f.model.validate!(encoded);
  expect(replay).toEqual(r);
});

it("applies explicit edges to the combined context, preserving overlapping interior quotes",()=>{
  const at=(before:string,after:string,edge:"none"|"start"|"end"|"both")=>resolveSourceContextQuote("あああ",{quote:"あ",before,after,edge});
  expect(at("あ","","start")).toEqual([1,2]);
  expect(at("","あ","end")).toEqual([1,2]);
  expect(at("あ","あ","both")).toEqual([1,2]);
  expect(()=>at("あ","","none")).toThrow("comparison_locator_invalid");
  expect(()=>at("あ","","both")).toThrow("comparison_locator_invalid");
});
it.each(["legacy_context","null_before","missing_edge","invalid_edge"])("rejects obsolete or incomplete context shapes: %s",async mode=>{
  const f=setup(),term=f.fact.meaning.objects[0][0];
  if(mode==="legacy_context")Object.assign(term,{context:null});
  if(mode==="null_before")Object.assign(term,{before:null});
  if(mode==="missing_edge")delete (term as {edge?:string}).edge;
  if(mode==="invalid_edge")Object.assign(term,{edge:"first"});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("rejects an empty direct quote before searching an edge-bound context",()=>{
  expect(()=>resolveSourceContextQuote("あああ",{quote:"",before:"",after:"",edge:"start"})).toThrow("comparison_locator_invalid");
});
