import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { decodeSourcePropositions, decodeTargetPropositions, propositionSourceInput, propositionSourceTransport, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { assessPropositions, assertPropositionTargetCoverage, renderPropositionDrafts } from "./proposition-result";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget } from "./proposition-fixtures.test-support";

function setup(){
  const f=fictionalInputs(),plan=makePlan(f.inputs,f.selection);
  const source=propositionSourceInput(plan),wire=propositionSourceTransport(source);
  const facts=decodeSourcePropositions(plan,fictionalPropositionSource(wire));
  const generated=fictionalPropositionGeneration(batchInput(plan));
  const drafts=plan.flatMap(c=>{
    const results=generated.results.filter(r=>r.docId===c.candidateId).map(r=>({baseClaimNo:r.baseClaimNo,candidateClaimNo:r.candidateClaimNo,
      baseEvidenceId:r.baseEvidenceId,candidateEvidenceId:r.candidateEvidenceId,baseObservation:r.baseObservation,
      candidateObservation:r.candidateObservation,common:r.common,differences:r.differences,unconfirmed:r.unconfirmed}));
    return validateAnswer(c,decodeGeneration(c,{results})).map(p=>({...p,...results.find(r=>r.baseClaimNo===p.baseClaimNo&&r.candidateClaimNo===p.candidateClaimNo)!}));
  });
  const input=propositionTargetInput(plan,drafts,facts),targetWire=propositionTargetTransport(input);
  return {...f,plan,source,wire,facts,drafts,input,targetWire,raw:fictionalPropositionTarget(targetWire)};
}
it("decodes both anchored extractions and renders the computed records",()=>{
  const f=setup(),assessment=assessPropositions(f.input,f.raw);
  assertPropositionTargetCoverage(f.input,assessment);
  const rendered=renderPropositionDrafts(f.input,assessment,f.drafts);
  expect(rendered).toHaveLength(2);
  expect(rendered[1].differences).toContain("下回る");
});
it("matches corresponding assertions before considering their presentation order",()=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":common"))!;
  const have="装置は青色弁を備える。",close="温度が七度を超える場合、装置は青色弁を閉じる。";
  target.text=`基準側の${have}基準側の${close}候補側の${close}候補側の${have}`;
  const raw=fictionalPropositionTarget(propositionTargetTransport(f.input));
  const assessment=assessPropositions(f.input,raw);
  expect(assessment.targets.find(t=>t.id===target.id)!.relation).toBe("entailed");
  assertPropositionTargetCoverage(f.input,assessment);
  const rendered=renderPropositionDrafts(f.input,assessment,f.drafts);
  expect(rendered[0].common).toContain("備える");expect(rendered[0].common).toContain("閉じる");
});
it("retains every original occurrence through an independent dictionary inverse",()=>{
  const f=setup();
  for(const [i,source] of f.wire.sources.entries())for(const [j,c] of source.source.claims.entries()){
    expect(c.parts.map(index=>f.wire.textParts[index]).join("")).toBe(f.source.sources[i].source.claims[j].segments.map(s=>s.text).join(""));
  }
  for(const [i,s] of [f.targetWire.originals.base,...f.targetWire.originals.documents.map(d=>d.source)].entries())
    for(const [j,c] of s.claims.entries()){
      const original=[f.input.originals.base,...f.input.originals.documents.map(d=>d.source)][i].claims[j];
      expect(c.segments.map(([id,index])=>[id,f.targetWire.textParts[index]])).toEqual(original.segments);
    }
  expect(f.wire.sources[0].source.claims[0].parts.map(i=>f.wire.textParts[i]).join("").indexOf("末尾条件")).toBeGreaterThan(15000);
});

it.each(["gap","missing_assertion","false_reservation","wrong_scope","wrong_claim","wrong_binding","source_id","old_verdict","empty_only_when"])("rejects a malformed target projection: %s",mode=>{
  const f=setup(),first=f.raw.targets[0].parts[0],atom=first.atoms[0];
  if(mode==="gap")first.span[0]++;
  if(mode==="missing_assertion")atom.basis=[[first.span[0],first.span[0]+2]];
  if(mode==="false_reservation")Object.assign(first,{form:"reservation",atoms:[],reservation:{topic:f.input.originals.targets[0].text,basis:first.span}});
  if(mode==="wrong_scope")atom.scope="candidate:21:1";
  if(mode==="wrong_claim")atom.claimNo=2;
  if(mode==="wrong_binding")atom.bindings[0].spans=[[0,1]];
  if(mode==="source_id")atom.sourceIds=["not_in_source"];
  if(mode==="old_verdict")Object.assign(atom,{verdict:"consistent"});
  if(mode==="empty_only_when")atom.meaning.guard={relation:"only_when",conditions:[]};
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it("does not move an explicit base assertion onto the candidate in a comparison field",()=>{
  const f=setup(),part=f.raw.targets.find(t=>t.id.endsWith(":common"))!.parts[0],atom=part.atoms[0];
  atom.scope="candidate:21:1";
  atom.sourceIds=[f.facts.facts.find(s=>s.scope===atom.scope&&s.meaning.kind==="relation"&&s.meaning.predicate==="has")!.id];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it("rejects a factual prefix hidden inside a reservation",()=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":unconfirmed"))!;
  target.text="基準側の装置は青色弁を閉じる。作用の対応は未確認。";
  const answer=f.raw.targets.find(t=>t.id===target.id)!;
  answer.parts=[{span:[0,target.text.length],form:"reservation",atoms:[],reference:null,
    reservation:{topic:target.text.slice(0,-6),basis:[0,target.text.length-6]}}];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it.each(["基準側は候補側の装置と同じ青色弁を備える。","基準側の装置と同じ青色弁を候補側は備える。"])("does not mistake a nested comparison operand for the assertion's side: %s",text=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":common"))!;
  const answer=f.raw.targets.find(t=>t.id===target.id)!,atom=answer.parts[0].atoms[0];
  target.text=text;
  const position=target.text.indexOf("青色弁");
  atom.meaning={kind:"relation",subject:null,context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",predicate:"has",objects:["青色弁"]};
  const candidate=text.indexOf("候補側")<position;
  atom.scope=candidate?"candidate:21:1":"base:1";
  atom.attribution=candidate?[4,7]:[0,3];atom.basis=[[0,target.text.length]];
  atom.bindings=[{term:"青色弁",spans:[[position,position+3]]}];
  atom.sourceIds=[f.facts.facts.find(s=>s.scope===atom.scope&&s.meaning.kind==="relation"&&s.meaning.predicate==="has")!.id];
  answer.parts=[{span:[0,target.text.length],form:"assertion",atoms:[atom],reference:null,reservation:null}];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it("retains reservations without treating them as proved factual assertions",()=>{
  const f=setup(),assessment=assessPropositions(f.input,f.raw);
  expect(assessment.targets.filter(t=>t.id.endsWith(":unconfirmed")).map(t=>t.relation)).toEqual(["nonassertive","nonassertive"]);
});
it("prefers a current part's explicit postposed side over the previous clause",()=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":common"))!;
  const answer=f.raw.targets.find(t=>t.id===target.id)!,prototype=answer.parts[0].atoms[0];
  const first="基準側は青色弁を備え、",second="青色弁を候補側は備える。";
  target.text=first+second;
  answer.parts=[first,second].map((text,i)=>{
    const start=i?first.length:0,scope=i?"candidate:21:1":"base:1",object=start+text.indexOf("青色弁"),side=start+text.indexOf(i?"候補側":"基準側");
    const atom=structuredClone(prototype);
    atom.meaning={kind:"relation",subject:null,context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",predicate:"has",objects:["青色弁"]};
    atom.basis=[[start,start+text.length]];atom.bindings=[{term:"青色弁",spans:[[object,object+3]]}];
    atom.scope=scope;atom.attribution=[side,side+3];
    atom.sourceIds=[f.facts.facts.find(s=>s.scope===scope&&s.meaning.kind==="relation"&&s.meaning.predicate==="has")!.id];
    return {span:[start,start+text.length],form:"assertion",atoms:[atom],reference:null,reservation:null};
  });
  expect(()=>decodeTargetPropositions(f.input,f.raw)).not.toThrow();
  const atom=answer.parts[1].atoms[0];atom.scope="base:1";atom.attribution=[0,3];atom.sourceIds=answer.parts[0].atoms[0].sourceIds;
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it("does not hide a factual annotation in a compound uncertainty topic",()=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":unconfirmed"))!;
  const topic="基準側の主弁全閉（確認済）、配置の対応";
  target.text=topic+"は未確認。";
  f.raw.targets.find(t=>t.id===target.id)!.parts=[{span:[0,target.text.length],form:"reservation",atoms:[],reference:null,
    reservation:{topic,basis:[0,topic.length]}}];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it("preserves an up-to reference without inventing an AND or swallowing a technical clause",()=>{
  const f=setup(),target=f.input.originals.targets.find(t=>t.id.endsWith(":candidateObservation"))!;
  const answer=f.raw.targets.find(t=>t.id===target.id)!;
  const text="請求項1までの装置・モード群を継承し、";
  target.text=text;
  answer.parts=[{span:[0,text.length],form:"reference",atoms:[],reservation:null,
    reference:{side:"candidate",claimNos:[1],relation:"unspecified"}}];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).not.toThrow();
  target.text="請求項1までの装置・モード群を継承し、青色弁を開く。";
  answer.parts[0].span[1]=target.text.length;
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
it.each(["reduced_numbers","other_side"])("does not silently change a bare reference: %s",mode=>{
  const f=setup(),text="基準側の請求項1の参照。";
  f.input.originals.targets[0].text=text;
  const part={span:[0,text.length] as [number,number],form:"reference" as const,atoms:[],reservation:null,
    reference:{side:"base" as "base"|"candidate",claimNos:[1],relation:"unspecified" as const}};
  f.raw.targets[0].parts=[part];
  expect(()=>decodeTargetPropositions(f.input,f.raw)).not.toThrow();
  if(mode==="reduced_numbers"){
    f.input.originals.targets[0].text="基準側の請求項1／2の参照。";
    f.input.originals.pairs[0].baseContextClaimNos.push(2);
    part.span[1]=f.input.originals.targets[0].text.length;
  }else part.reference.side="candidate";
  expect(()=>decodeTargetPropositions(f.input,f.raw)).toThrow("ai_incomplete");
});
