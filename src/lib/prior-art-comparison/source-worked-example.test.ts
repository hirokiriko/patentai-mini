import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { decodeSourcePropositions, propositionSourceInput, propositionSourceTransport } from "./proposition-extraction";
import { sourcePropositionModelSchemaFor } from "./proposition-locators";
import { SOURCE_WORKED_CLAIM, SOURCE_WORKED_PARTS } from "./source-worked-example";
import { compareProposition, type TargetProposition } from "./propositions";

function setup() {
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】\n"+SOURCE_WORKED_PARTS.join(""),11,"架空例");
  f.selection.draftClaimNos=[1];
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const row=structuredClone(SOURCE_WORKED_CLAIM);
  const wire={v:8,ss:input.sources.map((s,i)=>({sd:s.sourceDigest,
    cc:i===0?[row]:s.source.claims.map(c=>({cn:c.claimNo,rr:[],ff:[]}))}))};
  return {plan,input,row,wire,model:sourcePropositionModelSchemaFor(plan)};
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
  expect(facts[1].basis).toEqual([[105,211]]);
  expect(facts[1].meaning).toEqual({kind:"relation",subject:"第１の運転モード",context:"operation",
    guard:{relation:"when",conditions:["温度が五度を下回る"]},polarity:"positive",predicate:"generates_heat",objects:["補助ヒータ"]});
  const heat=parsed.facts.find(p=>p.meaning.kind==="relation"&&p.meaning.predicate==="generates_heat")!;
  const target:TargetProposition={id:"heat",targetId:"heat",span:[0,1],scope:heat.scope,claimNo:1,sourceIds:[heat.id],meaning:heat.meaning};
  expect(compareProposition(target,parsed.facts).relation).toBe("entailed");
  // A valid loop does not prove the separately printed thermal action.
  expect(compareProposition(target,parsed.facts.filter(p=>p.id!==heat.id)).relation).toBe("unresolved");
});
it.each(["mode_subject","occurrence","basis","unused","duplicate","missing_guard","traversed_pipe_excluded"])("rejects the worked example with %s evidence corrupted, without repairing raw",async kind=>{
  const f=setup(),loop=f.row.rr[0],heat=f.row.ff[0];
  if(kind==="mode_subject")loop.mm.su=loop.mm.or;
  if(kind==="occurrence")heat.ll[2].o=1;
  if(kind==="basis")loop.bb.lp=0;
  if(kind==="unused")heat.ll.push({q:"発熱させる",o:0});
  if(kind==="duplicate")heat.ll.push({...heat.ll[0]});
  if(kind==="missing_guard")Object.assign(heat.op,{gu:null});
  if(kind==="traversed_pipe_excluded")loop.mm.by.push([5]);
  const before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
  if(["missing_guard","traversed_pipe_excluded"].includes(kind)&&r.success)expect(()=>decodeSourcePropositions(f.plan,r.value)).toThrow("ai_incomplete");
  else expect(r.success).toBe(false);
  expect(JSON.stringify(f.wire)).toBe(before);
});
