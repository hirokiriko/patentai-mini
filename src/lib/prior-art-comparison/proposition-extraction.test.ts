import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan, validateAnswer } from "./comparison";
import { batchInput } from "./generation-batch";
import { decodeGeneration } from "./generation";
import { decodeSourcePropositions, decodeTargetPropositions, propositionSourceInput, propositionSourceTransport, propositionTargetInput, propositionTargetTransport } from "./proposition-extraction";
import { assessPropositions, assertPropositionTargetCoverage, renderMeaning, renderPropositionDrafts } from "./proposition-result";
import type { Meaning } from "./propositions";
import { fictionalPropositionSource, fictionalPropositionGeneration, fictionalPropositionTarget, fixturePropositionWire } from "./proposition-fixtures.test-support";
import { parseComparisonSource } from "./source";
import { sourcePropositionModelSchemaFor, targetPropositionModelSchemaFor, resolvePropositionQuote } from "./proposition-locators";
import { compactSourceWire } from "./source-wire-compact";

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
  expect(rendered[1].differences).toContain("開く機能を備える");
  expect(rendered[1].differences).toContain("閉じる機能を備える");
});
it.each<Meaning>([
  {kind:"relation",subject:"制御器",context:"capability",guard:{relation:"only_when",conditions:["高温"]},polarity:"positive",predicate:"opens",objects:["青色弁"]},
  {kind:"relation",subject:"入口",context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",predicate:"upstream",objects:["青色弁"]},
  {kind:"set",subject:"装置",context:"capability",guard:{relation:"unconditional",conditions:[]},polarity:"positive",selection:"one",extent:"closed",members:["青","緑"]},
  {kind:"path",subject:"青モード",context:"capability",guard:{relation:"when",conditions:["高温"]},polarity:"positive",origin:"入口",destination:"出口",via:["青色弁"],bypass:[],extent:"segment",relation:"route"},
])("retains capability versus actual operation in rendered $kind/$subject",meaning=>{
  const capability=renderMeaning(meaning),operation=renderMeaning({...meaning,context:"operation"});
  expect(capability).toContain("機能・構成として、");expect(operation).toContain("運転状態として、");
  expect(capability).not.toBe(operation);
  if(meaning.kind==="relation"&&meaning.predicate==="opens"){
    expect(capability).toContain("開く機能を備える");expect(operation).not.toContain("機能を備える");
    expect(capability).toContain("場合に限り");expect(operation).toContain("場合に限り");
  }
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
it("retains every original occurrence with explicit local source IDs and unchanged target dictionary",()=>{
  const f=setup();
  for(const [i,source] of f.wire.sources.entries())for(const [j,c] of source.source.claims.entries()){
    expect(c.parts.map(p=>p.text).join("")).toBe(f.source.sources[i].source.claims[j].segments.map(s=>s.text).join(""));
    expect(c.parts.map(p=>p.id)).toEqual(c.parts.map((_,index)=>index));
  }
  for(const [i,s] of [f.targetWire.originals.base,...f.targetWire.originals.documents.map(d=>d.source)].entries())
    for(const [j,c] of s.claims.entries()){
      const original=[f.input.originals.base,...f.input.originals.documents.map(d=>d.source)][i].claims[j];
      expect(c.segments.map(([id,index])=>[id,f.targetWire.textParts[index]])).toEqual(original.segments);
    }
  expect(f.wire.sources[0].source.claims[0].parts.map(p=>p.text).join("").indexOf("末尾条件")).toBeGreaterThan(15000);
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

// Independently written source and target readings. The fixture helper below
// only encodes target coordinates; it does not generate either meaning.
const plain={context:"capability" as const,guard:{relation:"unconditional" as const,conditions:[]},polarity:"positive" as const};
type SemanticExample={sourceText:string;sourceFacts:Meaning[];target:{text:string;meaning:Meaning}[]};
const semanticExamples:Record<string,SemanticExample>={
  maintenance:{sourceText:"制御器は停止後も赤弁が閉じた状態を維持する。",sourceFacts:[
    {...plain,kind:"relation",subject:"制御器",context:"operation",guard:{relation:"when",conditions:["停止後も"]},predicate:"maintains",objects:["赤弁が閉じた状態"]},
  ],target:[
    {text:"制御器は停止後も赤弁が閉じた状態を維持する。",meaning:{...plain,kind:"relation",subject:"制御器",context:"operation",guard:{relation:"when",conditions:["停止後も"]},predicate:"maintains",objects:["赤弁が閉じた状態"]}},
  ]},
  valves:{sourceText:"青モードでは高温かつ通電の場合、赤弁を開き、青弁を閉じる。",sourceFacts:[
    {...plain,kind:"relation",subject:"青モード",context:"operation",guard:{relation:"when",conditions:["高温","通電"]},predicate:"opens",objects:["赤弁"]},
    {...plain,kind:"relation",subject:"青モード",context:"operation",guard:{relation:"when",conditions:["高温","通電"]},predicate:"closes",objects:["青弁"]},
  ],target:[
    {text:"青モードは通電かつ高温の場合、赤弁を開く。",meaning:{...plain,kind:"relation",subject:"青モード",context:"operation",guard:{relation:"when",conditions:["通電","高温"]},predicate:"opens",objects:["赤弁"]}},
    {text:"青モードは通電かつ高温の場合、青弁を閉じる。",meaning:{...plain,kind:"relation",subject:"青モード",context:"operation",guard:{relation:"when",conditions:["通電","高温"]},predicate:"closes",objects:["青弁"]}},
  ]},
  heat:{sourceText:"青モードでヒータを発熱させる。ヒータは筐体内に配置される。",sourceFacts:[
    {...plain,kind:"relation",subject:"青モード",context:"operation",predicate:"generates_heat",objects:["ヒータ"]},
    {...plain,kind:"relation",subject:"ヒータ",predicate:"inside",objects:["筐体"]},
  ],target:[
    {text:"青モードはヒータを発熱させる。",meaning:{...plain,kind:"relation",subject:"青モード",context:"operation",predicate:"generates_heat",objects:["ヒータ"]}},
    {text:"ヒータは筐体内にある。",meaning:{...plain,kind:"relation",subject:"ヒータ",predicate:"inside",objects:["筐体"]}},
  ]},
  fixed:{sourceText:"第２の運転モードは紫色モードであり、分岐点は赤弁の上流にある。",sourceFacts:[
    {...plain,kind:"set",subject:"第２の運転モード",selection:"required",extent:"closed",members:["紫色モード"]},
    {...plain,kind:"relation",subject:"分岐点",predicate:"upstream",objects:["赤弁"]},
  ],target:[
    {text:"第2の運転モードは紫色モードである。",meaning:{...plain,kind:"set",subject:"第2の運転モード",selection:"required",extent:"closed",members:["紫色モード"]}},
    {text:"分岐点は赤弁の上流に位置する。",meaning:{...plain,kind:"relation",subject:"分岐点",predicate:"upstream",objects:["赤弁"]}},
  ]},
};
async function semanticConnection(name:string,changedSource?:Pick<SemanticExample,"sourceText"|"sourceFacts">){
  const example=semanticExamples[name],base=changedSource??example,f=fictionalInputs();
  f.inputs.draft=parseComparisonSource("【請求項1】"+base.sourceText,11,"架空基準");
  f.inputs.documents=[parseComparisonSource("【請求項1】"+example.sourceText,21,"架空候補")];
  f.selection.documents=f.selection.documents.slice(0,1);
  const plan=makePlan(f.inputs,f.selection),sourceInput=propositionSourceInput(plan),q=(quote:string,context:string|null=null)=>{
    const at=context?.indexOf(quote)??0;
    return {quote,before:context?.slice(0,at)??"",after:context?.slice(at+quote.length)??"",edge:"none" as const};
  };
  const sourceWire={locatorVersion:12,sources:sourceInput.sources.map((s,i)=>({sourceDigest:s.sourceDigest,
    c1:(i===0?base:example).sourceFacts.map((m,at)=>{
      // These two heat assertions deliberately mention the same component.
      // Their hand-authored readings select their own original clause.
      const context=name==="heat"?(i===0?base:example).sourceText.split("。")[at]:null;
      const {guard,...rest}=m,term=(v:string)=>[q(v,context)];
      return {meaning:{...rest,subject:m.subject===null?null:term(m.subject),guardRelation:guard.relation,guardConditions:guard.conditions.map(term),
          ...(m.kind==="set"?{members:m.members.map(term)}:m.kind==="relation"?{objects:m.objects.map(term)}:{})},
        operators:{selection:null,extent:null,polarity:null,guard:guard.relation==="when"?q(guard.conditions.join("かつ")):null,context:null},routeFrame:null};
    })}))};
  const sourceAnswer=await sourcePropositionModelSchemaFor(plan).validate!(compactSourceWire(sourceWire));
  if(!sourceAnswer.success)throw sourceAnswer.error;
  const sources=decodeSourcePropositions(plan,sourceAnswer.value),observation=example.target.map(t=>t.text).join("");
  const sides=example.target.flatMap(t=>["基準側の"+t.text,"候補側の"+t.text]).join("");
  const fields={baseObservation:observation,candidateObservation:observation,common:sides,differences:sides,unconfirmed:"図面は未確認。"};
  const pairs=validateAnswer(plan[0],{results:[{...plan[0].pairs[0],common:fields.common,differences:fields.differences,unconfirmed:fields.unconfirmed,
    baseEvidence:{claimNo:1,quote:base.sourceText},candidateEvidence:{claimNo:1,quote:example.sourceText}}]});
  const drafts=pairs.map(p=>({...p,...fields})),input=propositionTargetInput(plan,drafts,sources);
  const raw={draftDigest:input.draftDigest,targets:input.originals.targets.map(t=>{
    if(t.id.endsWith(":unconfirmed"))return {id:t.id,parts:[{span:[0,t.text.length],form:"reservation",atoms:[],reference:null,reservation:{topic:"図面",basis:[0,2]}}]};
    const both=t.id.endsWith(":common")||t.id.endsWith(":differences"),entries=example.target.flatMap(row=>
      (both?["base","candidate"]:[t.id.endsWith(":baseObservation")?"base":"candidate"]).map(side=>({row,side})));
    let cursor=0;
    return {id:t.id,parts:entries.map(({row,side})=>{
      const prefix=both?(side==="base"?"基準側の":"候補側の"):"",text=prefix+row.text,start=cursor;cursor+=text.length;
      const m=row.meaning,span=(quote:string)=>resolvePropositionQuote(text,quote,0).map(n=>n+start),scope=side==="base"?"base:1":"candidate:21:1";
      const terms=[m.subject,...m.guard.conditions,...(m.kind==="set"?m.members:m.kind==="relation"?m.objects:[])].filter((v):v is string=>v!==null);
      const own=input.sourcePropositions.filter(p=>p.scope===scope&&p.claimNo===1);
      // On a missing-predicate negative, retain a valid source ID and compare
      // against the remaining meaning instead of testing an invalid ID alone.
      const proof=own.find(p=>p.authority==="extracted"&&p.meaning.kind===m.kind&&
        (m.kind!=="relation"||p.meaning.kind==="relation"&&p.meaning.predicate===m.predicate))??own[0];
      return {span:[start,cursor],form:"assertion",reference:null,reservation:null,atoms:[{
        basis:[[start,cursor]],meaning:m,bindings:terms.map(term=>({term,spans:[span(term)]})),
        operators:{selection:null,extent:null,polarity:null,guard:m.guard.relation==="when"?span(m.guard.conditions.join("かつ")):null,context:null},
        routeFrame:null,scope,claimNo:1,attribution:both?[start,start+3]:null,sourceIds:[proof.id],
      }]};
    })};
  })};
  const wire=fixturePropositionWire(raw,propositionTargetTransport(input)),before=JSON.stringify(wire);
  const answer=await targetPropositionModelSchemaFor(input).validate!(wire);
  expect(JSON.stringify(wire)).toBe(before);if(!answer.success)throw answer.error;
  const assessment=assessPropositions(input,answer.value);
  return {input,drafts,raw:answer.value,assessment};
}
it.each(["valves","heat","fixed","maintenance"])("connects independent source and target readings through comparison and display: %s",async name=>{
  const f=await semanticConnection(name);assertPropositionTargetCoverage(f.input,f.assessment);
  expect(f.assessment.records.every(r=>r.relation==="entailed")).toBe(true);
  const result=renderPropositionDrafts(f.input,f.assessment,f.drafts)[0];
  expect(result.baseObservation.length).toBeLessThanOrEqual(120);
  expect(result.common.length).toBeLessThanOrEqual(200);
  for(const row of semanticExamples[name].target)expect(result.baseObservation).toContain(renderMeaning(row.meaning));
  // A candidate's valid location/operation cannot prove a base assertion.
  const changed=structuredClone(f.raw),atom=changed.targets[0].parts[0].atoms[0];
  atom.scope="candidate:21:1";atom.sourceIds=[f.input.sourcePropositions.find(p=>p.scope===atom.scope)!.id];
  expect(()=>assessPropositions(f.input,changed)).toThrow("ai_incomplete");
});
it.each(["missing_close","guard","mode","possession","outside","other_fixed","reverse_direction","missing_subject","state_to_action"])("does not erase an independent target assertion when source proof changes: %s",async change=>{
  const name=change==="state_to_action"?"maintenance":["missing_close","guard","mode"].includes(change)?"valves":["possession","outside"].includes(change)?"heat":"fixed";
  const base=structuredClone(semanticExamples[name]);
  if(change==="missing_close"){base.sourceText=base.sourceText.replace("、青弁を閉じる","");base.sourceFacts.pop();}
  if(change==="guard"){base.sourceText=base.sourceText.replace("高温","低温");base.sourceFacts.forEach(m=>m.guard.conditions=["低温","通電"]);}
  if(change==="mode"){base.sourceText=base.sourceText.replace("青モード","白モード");base.sourceFacts.forEach(m=>m.subject="白モード");}
  if(change==="possession"){base.sourceText=base.sourceText.replace("発熱させる","備える");if(base.sourceFacts[0].kind==="relation")base.sourceFacts[0].predicate="has";}
  if(change==="outside"){base.sourceText=base.sourceText.replace("筐体内に配置される","筐体の上流にある");if(base.sourceFacts[1].kind==="relation")base.sourceFacts[1].predicate="upstream";}
  if(change==="other_fixed"){base.sourceText=base.sourceText.replace("紫色モード","白色モード");if(base.sourceFacts[0].kind==="set")base.sourceFacts[0].members=["白色モード"];}
  if(change==="reverse_direction"){
    base.sourceText=base.sourceText.replace("分岐点は赤弁の上流","赤弁は分岐点の上流");
    if(base.sourceFacts[1].kind==="relation"){base.sourceFacts[1].subject="赤弁";base.sourceFacts[1].objects=["分岐点"];}
  }
  if(change==="missing_subject"&&base.sourceFacts[1].kind==="relation"){
    base.sourceFacts[1].subject=null;base.sourceFacts[1].objects=["分岐点","赤弁"];
  }
  if(change==="state_to_action"){
    base.sourceText=base.sourceText.replace("赤弁が閉じた状態を維持する","赤弁を閉じる");
    if(base.sourceFacts[0].kind==="relation"){base.sourceFacts[0].predicate="closes";base.sourceFacts[0].objects=["赤弁"];}
  }
  const f=await semanticConnection(name,base),baseRecords=f.assessment.records.filter(r=>r.target.scope==="base:1");
  const affected=baseRecords.filter(r=>change==="missing_close"?r.target.meaning.kind==="relation"&&r.target.meaning.predicate==="closes":
    change==="possession"?r.target.meaning.kind==="relation"&&r.target.meaning.predicate==="generates_heat":
    change==="outside"?r.target.meaning.kind==="relation"&&r.target.meaning.predicate==="inside":
    change==="other_fixed"?r.target.meaning.kind==="set":
    ["reverse_direction","missing_subject"].includes(change)?r.target.meaning.kind==="relation"&&r.target.meaning.predicate==="upstream":true);
  expect(affected.length).toBeGreaterThan(0);expect(affected.every(r=>r.relation!=="entailed")).toBe(true);
  expect(f.assessment.records.filter(r=>r.target.scope==="candidate:21:1").every(r=>r.relation==="entailed")).toBe(true);
  expect(()=>renderPropositionDrafts(f.input,f.assessment,f.drafts)).toThrow("ai_incomplete");
  expect(f.drafts[0].baseObservation).toBe(semanticExamples[name].target.map(t=>t.text).join(""));
});
