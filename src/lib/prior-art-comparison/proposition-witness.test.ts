import { expect, it } from "vitest";
import { compactSourceWitness, expandSourceWitness, compactSourceDescriptors } from "./proposition-witness";
import { decodeSourcePropositions, propositionSourceInput, propositionSourceTransport, type SourceExtraction } from "./proposition-extraction";
import { makePlan } from "./comparison";
import { fictionalInputs } from "./fixtures.test-support";
import { parseComparisonSource } from "./source";
import { fixturePropositionWire } from "./proposition-fixtures.test-support";
import { sourcePropositionModelSchemaFor } from "./proposition-locators";
import type { Meaning, Span } from "./propositions";

function fixture(){
  const heaters=["橙色器","白色器","緑色器","紫色器","黄色器","黒色器","銀色器","金色器","紺色器","桃色器"];
  const text="装置は青色弁と赤色弁を備え、温度が七度を超えかつ圧力が五を下回る場合、青色弁を開かない。"+
    "流体は循環器から混合器を経て循環器に戻り、赤色弁を迂回する。"+
    "加熱器は発熱し、放熱器は放熱し、吸熱器は吸熱する。"+heaters.map(h=>`${h}は発熱する。`).join("");
  const f=fictionalInputs();
  f.inputs.draft=parseComparisonSource(`【請求項1】${text}\n【請求項2】${text}`,11,"架空");
  f.selection.draftClaimNos=[1,2];
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(
    [1,2,3].map(n=>`【請求項${n}】${text}`).join("\n"),d.id,"架空候補"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const raw:SourceExtraction={sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,facts:[]}))};
  const span=(t:string):Span=>[text.indexOf(t),text.indexOf(t)+t.length];
  const neutral={selection:null,extent:null,polarity:null,guard:null,context:null};
  const common={subject:"装置",context:"capability" as const,guard:{relation:"unconditional" as const,conditions:[]},polarity:"positive" as const};
  const meanings:Meaning[]=[
    {...common,kind:"set",selection:"all",extent:"closed",members:["青色弁","赤色弁"]},
    {...common,kind:"relation",predicate:"opens",objects:["青色弁"],
      guard:{relation:"when",conditions:["温度が七度を超え","圧力が五を下回る"]},polarity:"negative"},
    {...common,kind:"path",subject:null,context:"operation",origin:"循環器",destination:"循環器",
      via:["混合器"],bypass:["赤色弁"],extent:"whole",relation:"route"},
    ...(["generates_heat","releases_heat","absorbs_heat"] as const).map((predicate,i)=>
      ({...common,kind:"relation" as const,subject:null,predicate,objects:[["加熱器","放熱器","吸熱器"][i]]})),
    {...common,kind:"relation",predicate:"has",objects:["青色弁","赤色弁"]},
    {...common,kind:"relation",predicate:"at_least",objects:["七度"]},
    {...common,kind:"relation",predicate:"at_most",objects:["五"]},
    {...common,kind:"relation",predicate:"maintains",objects:["青色弁"]},
    ...heaters.map(h=>({...common,subject:null,kind:"relation" as const,predicate:"generates_heat" as const,objects:[h]})),
  ];
  for(const [i,s]of input.sources.entries())for(const c of s.source.claims){
    for(const m of meanings){
      const terms=[...new Set([...(m.subject?[m.subject]:[]),...m.guard.conditions,...(m.kind==="set"?m.members:
        m.kind==="path"?[m.origin!,m.destination!,...m.via,...m.bypass]:m.objects)])];
      const routeStart=text.indexOf("循環器"),routeEnd=text.indexOf("戻り")+"戻り".length,last=text.lastIndexOf("循環器");
      raw.sources[i].facts.push({claimNo:c.claimNo,basis:[[0,text.length]],meaning:structuredClone(m),
        bindings:terms.map(term=>({term,spans:[span(term)]})),operators:{...neutral,
          guard:m.guard.relation==="when"?span("温度が七度を超えかつ圧力が五を下回る場合"):null,
          polarity:m.polarity==="negative"?span("開かない"):null},
        routeFrame:m.kind==="path"?{entry:[routeStart,routeStart+3],exit:[last,last+3],route:[routeStart,routeEnd],
          exclusions:[span("赤色弁を迂回する")],controls:[]}:null});
    }
  }
  return {raw,plan,input};
}
// v20 emits original-clause order. Compare every complete fact and its
// multiplicity, while source order and all fact fields remain significant.
const stableFields=(value:unknown):unknown=>Array.isArray(value)?value.map(stableFields):value&&typeof value==="object"?
  Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,stableFields(v)])):value;
const factMultiset=(raw:SourceExtraction)=>({...raw,sources:raw.sources.map(s=>({...s,
  facts:[...s.facts].sort((a,b)=>JSON.stringify(stableFields(a)).localeCompare(JSON.stringify(stableFields(b))))}))});
it("stores a complete repeated witness losslessly within the actual internal/descriptor caps",async()=>{
  const f=fixture(),wire=fixturePropositionWire(f.raw,propositionSourceTransport(f.input)),original=JSON.stringify(f.raw);
  const r=await sourcePropositionModelSchemaFor(f.plan).validate!(wire);expect(r.success).toBe(true);
  if(!r.success)return;
  expect(factMultiset(r.value as SourceExtraction)).toEqual(factMultiset(f.raw));
  const decoded=decodeSourcePropositions(f.plan,r.value);
  expect(expandSourceWitness(decoded.raw)).toEqual(r.value);
  expect(factMultiset(expandSourceWitness(decoded.raw))).toEqual(factMultiset(f.raw));
  expect(JSON.stringify(f.raw)).toBe(original);
  expect(f.raw.sources.reduce((n,s)=>n+s.facts.length,0)).toBeGreaterThanOrEqual(60);
  expect(Buffer.byteLength(original)).toBeGreaterThan(16_000);
  expect(Buffer.byteLength(JSON.stringify(wire))).toBeLessThanOrEqual(32_000);
  expect(Buffer.byteLength(JSON.stringify(decoded.raw))).toBeLessThanOrEqual(16_000);
  const descriptors=compactSourceDescriptors(decoded.facts.map(f=>({id:f.id,claimNo:f.claimNo,basis:f.basis,kind:f.meaning.kind,subject:f.meaning.subject})));
  expect(Buffer.byteLength(JSON.stringify(descriptors))).toBeLessThanOrEqual(6_000);
  expect(descriptors.map(([id,claimNo,basis,kind,subject])=>({id,claimNo,basis,kind,subject})))
    .toEqual(decoded.facts.map(f=>({id:f.id,claimNo:f.claimNo,basis:f.basis,kind:f.meaning.kind,subject:f.meaning.subject})));
});
it.each(["extra_term","extra_span","foreign_claim","bad_enum","extra_fact_field","extra_operator","invalid_index"])("rejects a corrupted compact witness %s",mode=>{
  const f=fixture(),w=compactSourceWitness(f.raw),s=w.sources[0],fact=s.facts[0];
  if(mode==="extra_term")s.terms.push("未使用語");
  if(mode==="extra_span")s.positions.push([1,0,1]);
  if(mode==="foreign_claim")s.positions[0][0]=999;
  if(mode==="bad_enum")fact[2][0]=7;
  if(mode==="extra_fact_field")(fact as unknown[]).push(null);
  if(mode==="extra_operator")fact[4].push(null);
  if(mode==="invalid_index")fact[1][0]=999;
  expect(()=>expandSourceWitness(w)).toThrow();
});
it("preserves every supported semantic enum and operator exactly",()=>{
  const f=fixture(),raw=f.raw,base=raw.sources[0].facts[0],meanings:Meaning[]=[];
  const {subject,context,guard,polarity}=base.meaning,common={subject,context,guard,polarity};
  for(const context of ["capability","operation","unresolved"] as const)
    for(const relation of ["unconditional","when","only_when","unresolved"] as const)
      for(const polarity of ["positive","negative","reserved"] as const)
        meanings.push({...base.meaning,context,guard:{relation,conditions:["温度"]},polarity});
  for(const selection of ["required","one","nonempty","all","unspecified"] as const)
    for(const extent of ["closed","partial"] as const)
      meanings.push({...common,kind:"set",selection,extent,members:["弁"]});
  for(const extent of ["segment","whole","unresolved"] as const)for(const relation of ["route","precedes"] as const)
    meanings.push({...common,kind:"path",origin:null,destination:"器",via:["弁"],bypass:[],extent,relation});
  for(const predicate of ["has","upstream","downstream","inside","opens","closes","fully_closes",
    "generates_heat","absorbs_heat","releases_heat","maintains","at_least","at_most","greater_than","less_than"] as const)
    meanings.push({...common,kind:"relation",predicate,objects:["弁"]});
  raw.sources[0].facts=meanings.map(meaning=>({...base,meaning,
    operators:{selection:[0,1],extent:[1,2],polarity:[2,3],guard:[3,4],context:[4,5]}}));
  // Codec coverage alone is not domain acceptance of these synthetic variants.
  expect(expandSourceWitness(compactSourceWitness(raw))).toEqual(raw);
});
