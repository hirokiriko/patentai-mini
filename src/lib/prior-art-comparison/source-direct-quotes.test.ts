import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { decodeSourcePropositions, propositionSourceInput } from "./proposition-extraction";
import { sourcePropositionModelSchemaFor } from "./proposition-locators";
import { compareProposition } from "./propositions";
import { SOURCE_ACTION_TEXT,SOURCE_ACTION_FACTS } from "./source-worked-example";

const q=(quote:string,occurrence=0)=>({quote,occurrence});
function setup(text="装置は青色弁を備える。",second?:string) {
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】"+text+(second?"\n【請求項2】"+second:""),11,"架空");
  f.selection.draftClaimNos=second?[1,2]:[1];
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire=JSON.parse(JSON.stringify({locatorVersion:9,sources:input.sources.map(s=>({
    sourceDigest:s.sourceDigest,coverage:s.source.claims.map(c=>({claimNo:c.claimNo,
      unresolved:{quote:c.segments.map(p=>p.text).join(""),occurrence:0,reason:"No additional fact supplied in this fictional test."}})),facts:[],
  }))}));
  const fact={claimNo:1,basis:{firstPart:0,lastPart:0},
    meaning:{kind:"relation",subject:[q("装置")],context:"capability",guardRelation:"unconditional",guardConditions:[],
      polarity:"positive",predicate:"has",objects:[[q("青色弁")]]},
    operators:{selection:null,extent:null,polarity:null,guard:null,context:null},routeFrame:null};
  wire.sources[0].facts=[fact];wire.sources[0].coverage[0].unresolved=null;
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
it.each(["missing","duplicate","reordered","foreign","empty_reason","whitespace_reason","missing_quote","absent_quote",
  "zero_without_reason","fact_with_reason"])("rejects incomplete claim accounting: %s",async mode=>{
  const f=setup("装置は青色弁を備える。","機器は赤色弁を備える。"),c=f.wire.sources[0].coverage;
  if(mode==="missing")c.pop();
  if(mode==="duplicate")c[1]=structuredClone(c[0]);
  if(mode==="reordered")c.reverse();
  if(mode==="foreign")c[1].claimNo=3;
  if(mode==="empty_reason")c[1].unresolved.reason="";
  if(mode==="whitespace_reason")c[1].unresolved.reason=" \n ";
  if(mode==="missing_quote")delete c[1].unresolved.quote;
  if(mode==="absent_quote")c[1].unresolved.quote="別の原文";
  if(mode==="zero_without_reason")c[1].unresolved=null;
  if(mode==="fact_with_reason")c[0].unresolved=structuredClone(c[1].unresolved);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["absent","negative","fraction","exhausted","old_index","old_table","old_version","other_source","foreign_claim",
  "wrong_basis","split_basis","reverse_basis","extra_basis","too_long_term","term_fragments_over80"])("rejects invalid direct evidence: %s",async mode=>{
  const f=setup(),a=f.fact;
  if(mode==="absent")a.meaning.objects[0][0].quote="別の弁";
  if(mode==="negative")a.meaning.objects[0][0].occurrence=-1;
  if(mode==="fraction")a.meaning.objects[0][0].occurrence=0.5;
  if(mode==="exhausted")a.meaning.objects[0][0].occurrence=1;
  if(mode==="old_index")Object.assign(a.meaning,{objects:[[0]]});
  if(mode==="old_table")Object.assign(a,{locators:[q("青色弁")]});
  if(mode==="old_version")f.wire.locatorVersion=8;
  if(mode==="other_source")f.wire.sources[0].sourceDigest=f.wire.sources[1].sourceDigest;
  if(mode==="foreign_claim")a.claimNo=2;
  if(mode==="wrong_basis")a.basis.lastPart=99;
  if(mode==="split_basis")Object.assign(a,{basis:[a.basis,a.basis]});
  if(mode==="reverse_basis"){a.basis.firstPart=1;a.basis.lastPart=0;}
  if(mode==="extra_basis")Object.assign(a.basis,{quote:"装置"});
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
  f.fact.meaning.objects[0][0].occurrence=9;
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("resolves occurrence inside the chosen range without searching a different part",async()=>{
  const f=setup("甲".repeat(125)+"、装置は甲を備える。"),parts=f.input.sources[0].source.claims[0].segments,last=parts.length-1;
  f.fact.basis={firstPart:last,lastPart:last};f.fact.meaning.objects=[[q("甲")]];
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].bindings.find(b=>b.term==="甲")!.spans[0][0])
    .toBe(parts.slice(0,last).reduce((n,p)=>n+p.text.length,0)+parts[last].text.indexOf("甲"));
  f.fact.basis={firstPart:0,lastPart:0};
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
  f.fact.basis.lastPart=f.input.sources[0].source.claims[0].segments.length-1;
  Object.assign(f.fact.meaning,{predicate:"opens",context:"operation",guardRelation:"when",guardConditions:cs.map(c=>[q(c)])});
  Object.assign(f.fact.operators,{guard:q(trigger)});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success){expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();expect(r.value.sources[0].facts[0].meaning.guard.conditions).toEqual(cs);}
});
it("decodes the actual opposite-action instruction example without replacing actions by a set",async()=>{
  const f=setup(SOURCE_ACTION_TEXT);f.wire.sources[0].facts=structuredClone(SOURCE_ACTION_FACTS);
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
  f.wire.sources[0].facts=[];f.wire.sources[0].coverage[0].unresolved={quote:"装置は青色弁を備える。",occurrence:0,reason:"Fixture intentionally withholds the extraction."};
  const empty=await f.model.validate!(f.wire);expect(empty.success).toBe(true);if(!empty.success)return;
  const target={id:"t",targetId:"t",span:[0,1]as [number,number],scope:p.scope,claimNo:1,sourceIds:[p.id],meaning:p.meaning};
  expect(compareProposition(target,decodeSourcePropositions(f.plan,empty.value).facts).relation).toBe("unresolved");
});
it("enforces 32000 UTF8 bytes on otherwise valid v9 facts",async()=>{
  const f=setup("装置は青色弁を備える。"+"x".repeat(6_000)+"。");
  f.fact.basis.lastPart=f.input.sources[0].source.claims[0].segments.length-1;
  const row={...f.fact,operators:{...f.fact.operators,guard:q("x".repeat(200))}};
  const bytes=()=>Buffer.byteLength(JSON.stringify(f.wire));
  let found=false;
  for(let n=1;n<=48;n++){
    f.wire.sources[0].facts=Array.from({length:n},()=>structuredClone(row));
    const last=f.wire.sources[0].facts[n-1];
    last.operators.guard=q("x");
    const remaining=31_999-bytes();
    if(remaining>=0&&remaining+3<=6_000){
      last.operators.guard=q("x".repeat(remaining+1));found=true;break;
    }
  }
  expect(found).toBe(true);expect(bytes()).toBe(31_999);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  const last=f.wire.sources[0].facts.at(-1);
  last.operators.guard.quote+="x";
  expect(bytes()).toBe(32_000);expect((await f.model.validate!(f.wire)).success).toBe(true);
  last.operators.guard.quote+="x";
  expect(bytes()).toBe(32_001);expect((await f.model.validate!(f.wire)).success).toBe(false);
  expect((await f.model.validate!({v:8,ss:[]})).success).toBe(false);
});
it.each(["unique","absent","repeated","overlap","surrogate"])("requires explicit occurrence even for a unique quote: %s",async mode=>{
  const text=mode==="repeated"?"装置は青色弁と青色弁を備える。":
    mode==="overlap"?"装置はあああを備える。":mode==="surrogate"?"装置は😀を備える。":"装置は青色弁を備える。";
  const f=setup(text),literal=mode==="absent"?"別の弁":mode==="overlap"?"ああ":mode==="surrogate"?"\ud83d":"青色弁";
  Object.assign(f.fact.meaning,{subject:["装置"],objects:[[literal]]});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  Object.assign(f.fact.meaning,{subject:[q("装置")],objects:[[q(literal,mode==="repeated"||mode==="overlap"?1:0)]]});
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
  const f=setup(SOURCE_ACTION_TEXT);f.wire.sources[0].facts=structuredClone(SOURCE_ACTION_FACTS);
  const a=f.wire.sources[0].facts[0];
  if(mode==="operator_string")a.operators.guard="前記通電状態で温度が七度を超える場合";
  if(mode==="missing_key")delete a.operators.context;
  if(mode==="extra_key")a.operators.invented=null;
  if(mode==="composed_guard")a.operators.guard=q("通電状態で前記温度が七度を超える場合");
  const before=JSON.stringify(f.wire);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  expect(JSON.stringify(f.wire)).toBe(before);
});
it("rejects a subject outside a valid selected part even when its object is within that part",async()=>{
  const f=setup("装置は"+"甲".repeat(125)+"、青色弁を備える。");
  const parts=f.input.sources[0].source.claims[0].segments,last=parts.length-1;
  expect(last).toBeGreaterThan(0);
  expect(parts[last].text).toContain("青色弁");expect(parts[last].text).not.toContain("装置");
  f.fact.basis={firstPart:last,lastPart:last};
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  Object.assign(f.fact.meaning,{subject:null});
  expect((await f.model.validate!(f.wire)).success).toBe(true);
});
it("allows only operator/frame evidence to name the already selected whole basis",async()=>{
  const f=setup();Object.assign(f.fact.operators,{guard:{quote:null,occurrence:0}});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success)expect(r.value.sources[0].facts[0].operators.guard).toEqual(r.value.sources[0].facts[0].basis[0]);
  Object.assign(f.fact.operators,{guard:{quote:null,occurrence:1}});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
  Object.assign(f.fact.operators,{guard:null});
  Object.assign(f.fact.meaning,{objects:[[{quote:null,occurrence:0}]]});
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it.each(["送出器","予備送出器"])("checks exact component equivalence in manual route frames: %s",async inlet=>{
  const route=`流体は${inlet}から受入器へ流れる。`,f=setup(`前記送出器を備える。${route}`);
  Object.assign(f.fact,{meaning:{kind:"path",subject:null,context:"operation",guardRelation:"unconditional",
    guardConditions:[],polarity:"positive",origin:[q("前記送出器")],destination:[q("受入器")],via:[],bypass:[],
    extent:"whole",relation:"route"},
    routeFrame:{entry:q(inlet,inlet==="送出器"?1:0),exit:q("受入器"),route:q(route),exclusions:[],controls:[]}});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);if(!r.success)return;
  if(inlet==="送出器")expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
  else expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
});
