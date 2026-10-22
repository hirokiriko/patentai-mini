import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceSemanticPropositionModelSchemaFor,propositionSourceSemanticTransport} from "./source-semantic-wire";
import {SOURCE_SEMANTIC_ACTION_EXAMPLE} from "./source-semantic-prompt";
import {sourceReadingClaim} from "./source-clause-coverage";
import {sourceActionCues,sourceOrGroups} from "./source-semantic-check";
import {sourceClausePropositionModelSchemaFor} from "./source-clause-wire";

type Fact={m:Record<string,unknown>;O:Record<string,unknown>;F:unknown;W:number[]};
const neutral=()=>({selection:null,extent:null,polarity:null,guard:null,context:null} as Record<string,unknown>);
function setup(text=SOURCE_SEMANTIC_ACTION_EXAMPLE.clauses.map(c=>c[1]).join(""),facts:Fact[]=[structuredClone(SOURCE_SEMANTIC_ACTION_EXAMPLE.fact)]){
  const f=fictionalInputs(),source="【請求項1】"+text;
  f.inputs.draft=parseComparisonSource(source,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(source,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const wire={v:17,s:input.sources.map(s=>({d:s.sourceDigest,c1:structuredClone(facts)}))};
  return {plan,input,wire,model:sourceSemanticPropositionModelSchemaFor(plan)};
}
function relation(P:string,J:string[][],a:string,W:number[],more:Record<string,unknown>={}):Fact{
  return {m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P,J,a,...more},O:neutral(),F:null,W};
}
it("decodes a grounded close with unchanged complete negative-power condition and raw bytes",async()=>{
  const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);expect(r.success).toBe(true);
  if(r.success){const d=decodeSourcePropositions(f.plan,r.value);expect(d.facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="closes"&&f.meaning.guard.conditions[0]==="非通電状態の場合")).toBe(true);}
  expect(JSON.stringify(f.wire)).toBe(before);
});
it.each(["nested_subject","array_proof","array_O","missing_O","extra_quote","numeric_predicate","unknown_predicate","legacy","W13"])("rejects acquired failure shape: %s",async mode=>{
  const f=setup(),p=f.wire.s[0].c1[0];
  if(mode==="nested_subject")p.m.u=[["制御器"]];
  if(mode==="array_proof")p.O.context=["閉じる"];
  if(mode==="array_O")(p as unknown as Record<string,unknown>).O=[null,null,null,[1],[0,1,2]];
  if(mode==="missing_O")delete p.O.guard;
  if(mode==="extra_quote")p.m.u=[{quote:"制御器",before:"",after:"",extra:1}];
  if(mode==="numeric_predicate")p.m.P=5;
  if(mode==="unknown_predicate")p.m.P="stop_or_close";
  if(mode==="legacy")f.wire.v=16;
  if(mode==="W13")p.W=Array.from({length:13},(_,i)=>i);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("uses provider-enforced object structure and named predicate enums",async()=>{
  const s=await setup().model.jsonSchema,defs=s.definitions!;
  const def=(key:string)=>{const value=defs[key];if(typeof value==="boolean")throw Error("object_schema_required");return value;};
  expect(def("PriorArtSourceOperators").type).toBe("object");
  expect(def("PriorArtSourceOperators").required).toEqual(["selection","extent","polarity","guard","context"]);
  expect(def("PriorArtSourceQuoteContext").additionalProperties).toBe(false);
  expect(def("PriorArtSourceQuoteContext").required).toEqual(["quote","before","after"]);
  expect(def("PriorArtSourceCellQuote").anyOf!.some(s=>typeof s!=="boolean"&&s.type==="array")).toBe(false);
  const relations=def("PriorArtSourceMeaning").anyOf!.find(s=>typeof s!=="boolean"&&s.properties?.P)!;
  expect(typeof relations!=="boolean"&&relations.properties!.P).toMatchObject({type:"string",enum:expect.arrayContaining(["closes","stops","releases_heat","absorbs_heat"])});
});
it("does not reinterpret a stopping condition as the closing predicate",async()=>{
  const text="圧縮機を停止した後、赤弁を閉じる。";
  const close=relation("closes",[["赤弁"]],"閉じる",[0,1],{g:"when",G:[["圧縮機を停止した後"]]});close.O.guard=[0];
  const f=setup(text,[close]);expect((await f.model.validate!(f.wire)).success).toBe(true);
  for(const a of ["閉じる","圧縮機を停止した後、赤弁を閉じる"]){f.wire.s[0].c1[0].m.P="stops";f.wire.s[0].c1[0].m.a=a;expect((await f.model.validate!(f.wire)).success).toBe(false);}
});
it("keeps closed-state maintenance, negated closure, full closure and unrelated compounds separate",async()=>{
  expect(sourceActionCues(sourceReadingClaim(1,"流体を閉じ込める。放熱器と吸熱器を備える。"))).toEqual([]);
  const maintained=relation("maintains",[["赤弁を閉じた状態を維持する"]],"赤弁を閉じた状態を維持する",[0]);
  const m=setup("赤弁を閉じた状態を維持する。",[maintained]);expect((await m.model.validate!(m.wire)).success).toBe(true);
  const n=relation("closes",[["赤弁"]],"閉じない",[0],{p:"negative"});n.O.polarity="閉じない";
  const f=setup("赤弁を閉じない。",[n]);expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.wire.s[0].c1[0].m.p="positive";expect((await f.model.validate!(f.wire)).success).toBe(false);
  const full=setup("赤弁を完全に閉じる。",[relation("fully_closes",[["赤弁"]],"完全に閉じる",[0])]);
  expect((await full.model.validate!(full.wire)).success).toBe(true);
  full.wire.s[0].c1[0].m.P="closes";expect((await full.model.validate!(full.wire)).success).toBe(false);
});
it("requires independent releasing and absorbing heat facts even when paths or W cover both",async()=>{
  const text="冷媒を青熱交換器にて放熱させ、白熱交換器にて吸熱させる。";
  const heat=[relation("releases_heat",[["青熱交換器"]],"放熱させ",[0]),relation("absorbs_heat",[["白熱交換器"]],"吸熱させ",[1])];
  const f=setup(text,heat);expect((await f.model.validate!(f.wire)).success).toBe(true);
  for(const J of [[["冷媒"]],[["にて"]]]){const bad=setup(text,heat);bad.wire.s[0].c1[0].m.J=J;expect((await bad.model.validate!(bad.wire)).success).toBe(false);}
  const omitted=setup(text,heat);omitted.wire.s[0].c1.pop();omitted.wire.s[0].c1[0].W=[0,1];
  expect((await omitted.model.validate!(omitted.wire)).success).toBe(false);
  const path=setup(text,[{m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"path",i:["青熱交換器"],j:["白熱交換器"],V:[],B:[],e:"segment",r:"route"},O:neutral(),F:null,W:[0,1]}]);
  expect((await path.model.validate!(path.wire)).success).toBe(false);
});
it("preserves a complete OR, rejects AND substitution and missing alternatives, and accepts complete branch expansion",async()=>{
  const text="温度が下がった後、又は、圧力が下がった後に赤弁を閉じる。",c=sourceReadingClaim(1,text);
  expect(sourceOrGroups(c)).toHaveLength(1);
  const branches=["温度が下がった後","圧力が下がった後"],whole=branches.join("、又は、");
  const make=(G:string[][])=>{const f=relation("closes",[["赤弁"]],"閉じる",[0,1,2],{g:"when",G});f.O.guard=[0,1,2];return f;};
  const good=setup(text,[make([[whole]])]);expect((await good.model.validate!(good.wire)).success).toBe(true);
  const and=setup(text,[make(branches.map(x=>[x]))]);expect((await and.model.validate!(and.wire)).success).toBe(false);
  const expanded=setup(text,branches.map(x=>make([[x]])));expect((await expanded.model.validate!(expanded.wire)).success).toBe(true);
  expanded.wire.s[0].c1.pop();expect((await expanded.model.validate!(expanded.wire)).success).toBe(false);
  const missing=setup(text,[relation("closes",[["赤弁"]],"閉じる",[0,1,2])]);expect((await missing.model.validate!(missing.wire)).success).toBe(false);
});
it("retains ordinary AND and exact context objects",async()=>{
  const text="制御器は、温度が下がりかつ圧力が下がった場合、赤弁を閉じる。";
  const f=setup(text,[relation("closes",[["赤弁"]],"閉じる",[0,1,2],{u:[{quote:"制御器",before:"",after:"は、"}],g:"when",G:[["温度が下がり"],["圧力が下がった場合"]]})]);
  for(const s of f.wire.s)s.c1[0].O.guard=[1];
  expect((await f.model.validate!(f.wire)).success).toBe(true);
});
it("allows more than48 complete grounded facts without changing the legacy admission cap",async()=>{
  const texts=Array.from({length:52},(_,i)=>`第${i+1}熱交換器にて放熱させる。`),text=texts.join("");
  const facts=texts.map((_,i)=>relation("releases_heat",[[`第${i+1}熱交換器`]],"放熱させ",[i]));
  const f=setup(text,facts),result=await f.model.validate!(f.wire);expect(result.success).toBe(true);
  if(result.success)expect(decodeSourcePropositions(f.plan,result.value).raw).toBeTruthy();
  const legacy={v:16,s:f.wire.s.map(s=>({d:s.d,c1:s.c1.map(p=>({
    ...p,m:{u:null,x:1,g:0,G:[],p:0,k:2,P:9,J:p.m.J},O:[null,null,null,null,null],
  }))}))};
  expect(Buffer.byteLength(JSON.stringify(legacy))).toBeLessThanOrEqual(32_000);
  expect((await sourceClausePropositionModelSchemaFor(f.plan,16).validate!(legacy)).success).toBe(false);
});
it.each(["赤弁を全閉にしない。","赤弁を閉じていない。","赤弁を閉じなかった。"])("does not force a positive fact from an explicit negative state: %s",text=>{
  const cues=sourceActionCues(sourceReadingClaim(1,text));expect(cues).toHaveLength(1);expect(cues[0].polarity).toBe("negative");
});
it("retains distinct capability and operation facts and a real inherited reference without copying its parent",async()=>{
  const original=fictionalInputs(),text="【請求項1】加熱器は発熱する。\n【請求項2】請求項1に記載の装置であって、運転中、加熱器を発熱させる。";
  original.inputs.draft=parseComparisonSource(text,11,"架空");original.selection.draftClaimNos=[2];
  original.inputs.documents=original.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
  original.selection.documents=original.selection.documents.map(d=>({...d,claimNos:[2]}));
  const plan=makePlan(original.inputs,original.selection),input=propositionSourceInput(plan);
  const capability=relation("generates_heat",[["加熱器"]],"発熱する",[0],{x:"capability"});
  const operation=relation("generates_heat",[["加熱器"]],"発熱させ",[0,1,2],{g:"when",G:[["運転中"]]});operation.O.guard=[1];
  const wire={v:17,s:input.sources.map(s=>({d:s.sourceDigest,c1:[capability],c2:[operation]}))};
  const result=await sourceSemanticPropositionModelSchemaFor(plan).validate!(wire);expect(result.success).toBe(true);
  const transport=propositionSourceSemanticTransport(input);
  expect(transport.sources.every(s=>s.source.claims.find(c=>c.claimNo===2)?.dependsOn.includes(1))).toBe(true);
  if(result.success){const decoded=decodeSourcePropositions(plan,result.value);expect(decoded.facts.some(f=>f.claimNo===1&&f.meaning.context==="capability")).toBe(true);expect(decoded.facts.some(f=>f.claimNo===2&&f.meaning.context==="operation")).toBe(true);}
});
it.each([
  ["fully_closes","全閉しない","赤弁"],["fully_closes","全閉しなかった","赤弁"],
  ["releases_heat","放熱していない","青熱交換器"],["releases_heat","放熱していなかった","青熱交換器"],
  ["releases_heat","放熱させることはない","青熱交換器"],["closes","閉じることはない","赤弁"],
])("preserves the complete negative action %s %s",async(P,a,object)=>{
  const fact=relation(P,[[object]],a,[0],{p:"negative"});fact.O.polarity=a;
  const f=setup(`${object}を${a}。`,[fact]);expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.wire.s[0].c1[0].m.p="positive";expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("validates over512 distinct fact-scoped quotes within the new bounded capacity",async()=>{
  const texts=Array.from({length:74},(_,i)=>`U${i}は、A${i}及びB及びC及びD及びEを開く。`);
  const facts=texts.map((_,i)=>{
    const W=[2*i,2*i+1];
    const f=relation("opens",[[`A${i}`],["B"],["C"],["D"],["E"]],"開く",W,{u:[`U${i}`]});
    f.O.context=W;return f;
  });
  const f=setup(texts.join(""),facts);expect(Buffer.byteLength(JSON.stringify(f.wire))).toBeLessThanOrEqual(64_000);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
});
