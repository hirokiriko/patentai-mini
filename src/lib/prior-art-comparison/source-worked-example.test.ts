import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { decodeSourcePropositions, propositionSourceInput, legacyPropositionSourceTransport as propositionSourceTransport } from "./proposition-extraction";
import { compactDirectSourcePropositionModelSchemaFor as sourcePropositionModelSchemaFor } from "./source-direct-quotes";
import { SOURCE_WORKED_FACTS, SOURCE_WORKED_PARTS } from "./source-worked-example";
import { compareProposition, type TargetProposition } from "./propositions";
import { fixtureRequiredSourceWire } from "../../../scripts/prior-art-proposition-fixture.mjs";
import { compactSourceWire } from "./source-wire-compact";

function setup() {
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】\n"+SOURCE_WORKED_PARTS.join(""),11,"架空例");
  f.selection.draftClaimNos=[1];
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const rows=structuredClone(SOURCE_WORKED_FACTS).map(f=>({claimNo:1,basis:{firstPart:0,lastPart:1},...f}));
  const wire={locatorVersion:9,sources:input.sources.map((s,i)=>({sourceDigest:s.sourceDigest,
    coverage:s.source.claims.map(c=>({claimNo:c.claimNo,unresolved:i===0?null:
      {quote:c.segments.map(p=>p.text).join(""),before:"",after:"",edge:"none",reason:"Fixture has no additional fact."}})),facts:i===0?rows:[]}))};
  return {plan,input,rows,get wire(){return compactSourceWire(fixtureRequiredSourceWire(wire));},model:sourcePropositionModelSchemaFor(plan)};
}
it("decodes the actual instruction example, preserving loop roles, exact endpoints and a separate guarded heat action",async()=>{
  const f=setup(),input=propositionSourceTransport(f.input),before=JSON.stringify(f.wire);
  expect(input.sources[0].source.claims[0].parts.map(p=>p.text)).toEqual(SOURCE_WORKED_PARTS);
  expect(input.sources[0].recognizedLoopRoutes).toHaveLength(1);
  expect(input.sources[0].recognizedLoopRoutes[0]).toMatchObject({id:0,basisParts:[0,1]});
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  expect(JSON.stringify(f.wire)).toBe(before);if(!r.success)return;
  const parsed=decodeSourcePropositions(f.plan,r.value),facts=r.value.sources[0].facts;
  expect(facts).toHaveLength(2);
  expect(facts[0].meaning).toEqual({kind:"path",subject:"第１の運転モード",context:"operation",
    guard:{relation:"unconditional",conditions:[]},polarity:"positive",origin:"送出器",destination:"送出器",
    via:["加熱器","分岐器","バイパス配管","蓄積器"],bypass:["冷却器"],extent:"whole",relation:"route"});
  expect(facts[0].routeFrame!.entry).toEqual([83,86]);
  expect(facts[0].routeFrame!.exit).toEqual([135,138]);
  expect(facts[1].basis).toEqual([[0,211]]);
  expect(facts[1].meaning).toEqual({kind:"relation",subject:"第１の運転モード",context:"operation",
    guard:{relation:"when",conditions:["温度が五度を下回る"]},polarity:"positive",predicate:"generates_heat",objects:["補助ヒータ"]});
  const heat=parsed.facts.find(p=>p.meaning.kind==="relation"&&p.meaning.predicate==="generates_heat")!;
  const target:TargetProposition={id:"heat",targetId:"heat",span:[0,1],scope:heat.scope,claimNo:1,sourceIds:[heat.id],meaning:heat.meaning};
  expect(compareProposition(target,parsed.facts).relation).toBe("entailed");
  // A valid loop does not prove the separately printed thermal action.
  expect(compareProposition(target,parsed.facts.filter(p=>p.id!==heat.id)).relation).toBe("unresolved");
});
it.each(["mode_subject","context","basis","legacy_table","missing_guard","traversed_pipe_excluded","nonpath_frame","duplicate_loop"])("rejects the worked example with %s evidence corrupted, without repairing raw",async kind=>{
  const f=setup(),loop=f.rows[0],heat=f.rows[1];
  if(kind==="mode_subject")loop.meaning.subject=loop.meaning.origin!;
  if(kind==="context")heat.meaning.objects![0][0].after="別の原文";
  if(kind==="basis")loop.basis.lastPart=0;
  if(kind==="legacy_table")Object.assign(heat,{locators:[]});
  if(kind==="missing_guard")Object.assign(heat.operators!,{guard:null});
  if(kind==="nonpath_frame")heat.routeFrame=0;
  if(kind==="duplicate_loop")f.rows.push(structuredClone(loop));
  if(kind==="traversed_pipe_excluded")loop.meaning.bypass!.push(loop.meaning.via![2]);
  const before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
  if(["missing_guard","traversed_pipe_excluded"].includes(kind)&&r.success)expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
  else expect(r.success).toBe(false);
  expect(JSON.stringify(f.wire)).toBe(before);
});
it("accepts prefixed names at the SAME catalog component without changing exact locations",async()=>{
  const f=setup();f.rows[0].meaning.origin![0].quote="前記送出器";f.rows[0].meaning.destination![0].quote="前記送出器";
  f.rows[0].meaning.origin![0].before="";f.rows[0].meaning.destination![0].before="";
  const r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success){expect(()=>decodeSourcePropositions(f.plan,r.value)).not.toThrow();
    expect(r.value.sources[0].facts[0].routeFrame!.entry).toEqual([83,86]);}
});
