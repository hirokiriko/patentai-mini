import { fixtureGridText, fixtureGridWire } from "./prior-art-grid-fixture.mjs";
import { fixtureClauseWire } from "./prior-art-clause-fixture.mjs";
export { fixtureDeclareClauseReading } from "./prior-art-clause-fixture.mjs";
// Fully fictional SDK responses. Hand-authored semantic extraction is test
// plumbing only and must never be reported as real-model extraction quality.
const fixtureInputs = new WeakMap();
const withInput = (value,input) => { fixtureInputs.set(value,input);return value; };
// Independent test spelling of source v8; production codecs are not imported.
const sourceNames={locatorVersion:"v",sources:"ss",sourceDigest:"sd",claims:"cc",claimNo:"cn",
  requiredLoops:"rr",facts:"ff",basis:"bb",firstPart:"fp",lastPart:"lp",locators:"ll",
  quote:"q",occurrence:"o",meaning:"mm",operators:"op",routeFrame:"rf",subject:"su",context:"cx",
  guardRelation:"gr",guardConditions:"gc",polarity:"po",kind:"ki",selection:"se",extent:"ex",
  members:"me",origin:"or",destination:"de",via:"vi",bypass:"by",relation:"re",predicate:"pr",
  objects:"ob",guard:"gu",entry:"en",exit:"et",route:"rt",exclusions:"ec",controls:"ct"};
const sourceReverse=Object.fromEntries(Object.entries(sourceNames).map(([a,b])=>[b,a]));
function rename(value,names){
  if(Array.isArray(value))return value.map(v=>rename(v,names));
  if(!value||typeof value!=="object")return value;
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[names[k]??k,rename(v,names)]));
}
export const fixtureCompactSource = value => rename(flattenGuards(value),sourceNames);
export const fixtureExpandSource = value => rename(value,sourceReverse);
// Independent wire spelling only; never fills a missing coverage row or loop.
// The caller explicitly supplies every numeric loop fact before conversion.
export function fixtureRequiredSourceWire(wire) {
  return {...wire,locatorVersion:12,sources:wire.sources.map(s=>{
    const coverage=Object.fromEntries(s.coverage.map(c=>[`c${c.claimNo}`,c.unresolved]));
    if(Object.keys(coverage).length!==s.coverage.length)throw Error("fictional_duplicate_coverage");
    if(s.facts.some(f=>!Object.hasOwn(coverage,`c${f.claimNo}`)))throw Error("fictional_foreign_claim");
    const loops={},facts=[];
    for(const fact of s.facts){
      const key=`loop${fact.routeFrame}`;
      if(typeof fact.routeFrame==="number"&&!(key in loops))loops[key]=fact;
      else facts.push(fact);
    }
    const claims=Object.fromEntries(s.coverage.map(c=>{
      const own=facts.filter(f=>f.claimNo===c.claimNo).map(({claimNo,basis,...f})=>f);
      const hasLoop=Object.values(loops).some(f=>f.claimNo===c.claimNo);
      if((own.length||hasLoop)&&c.unresolved!==null)throw Error("fictional_conflicting_claim_answer");
      return [`c${c.claimNo}`,own.length||hasLoop?own:c.unresolved];
    }));
    return {sourceDigest:s.sourceDigest,...claims,...loops};
  })};
}
function flattenGuards(value) {
  if (Array.isArray(value)) return value.map(flattenGuards);
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, flattenGuards(child)]));
  if (row.guard && ["set", "path", "relation"].includes(String(row.kind))) {
    const guard = row.guard;
    delete row.guard; row.guardRelation = guard.relation; row.guardConditions = guard.conditions;
  }
  return row;
}
// Independent inverse used only for fictional responses. A WeakMap retains
// the originating fictional input across tests that mutate an answer in place.
export function fixturePropositionWire(value,input=fixtureInputs.get(value)) {
  if(input?.citationClauses)return fixtureClauseWire(value,input);
  if(input?.citationGrid)return fixtureGridWire(value,input);
  if(value.locatorVersion===12||value.locatorVersion===11||value.locatorVersion===10)return flattenGuards(value);
  if(value.locatorVersion===9)return flattenGuards(value);
  if(!input||[1,2,3,4,5,6,7,8].includes(value.locatorVersion))return flattenGuards(value);
  const table = (textFor,partsFor) => {
    const locators=[];
    const add=(range,claimNo)=>{
      const text=textFor(claimNo);
      if(!Array.isArray(range)||range.length!==2||range.some(n=>!Number.isSafeInteger(n))||
        range[0]<0||range[1]<=range[0]||range[1]>text.length)throw Error("fictional_locator_invalid");
      const [start,end]=range,quote=text.slice(start,end);
      let anchor=text,offset=0,partIds={};
      if(partsFor){
        let cursor=0;const parts=partsFor(claimNo).map(t=>{const a=cursor;cursor+=t.length;return[a,cursor];});
        const firstPart=parts.findIndex(([a,b])=>start>=a&&start<b),lastPart=parts.findIndex(([a,b])=>end>a&&end<=b);
        if(firstPart<0||lastPart<firstPart)throw Error("fictional_locator_invalid");
        offset=parts[firstPart][0];anchor=text.slice(offset,parts[lastPart][1]);partIds={firstPart,lastPart};
      }
      let occurrence=0,at=anchor.indexOf(quote);
      while(at>=0&&at<start-offset){occurrence++;at=anchor.indexOf(quote,at+1);}
      if(at!==start-offset)throw Error("fictional_locator_invalid");
      const entry={quote,occurrence,...(claimNo===undefined?{}:{claimNo}),...partIds};
      let id=locators.findIndex(l=>JSON.stringify(l)===JSON.stringify(entry));
      if(id<0){id=locators.length;locators.push(entry);}return id;
    };
    return {locators,add};
  };
  const fact=(f,add)=>({...f,basis:f.basis.map(add),bindings:f.bindings.map(b=>({...b,spans:b.spans.map(add)})),
    operators:Object.fromEntries(Object.entries(f.operators).map(([k,s])=>[k,s===null?null:add(s)])),
    routeFrame:f.routeFrame?{entry:add(f.routeFrame.entry),exit:add(f.routeFrame.exit),route:add(f.routeFrame.route),
      exclusions:f.routeFrame.exclusions.map(add),controls:f.routeFrame.controls.map(add)}:null});
  if(input.task==="extract_source_propositions")return fixtureRequiredSourceWire(flattenGuards({locatorVersion:9,sources:value.sources.map(s=>{
    // Preserve deliberately invalid digests in negative tests; use the fixture
    // row's original source only to encode its unchanged quote positions.
    const source=(input.sources.find(x=>x.sourceDigest===s.sourceDigest)??input.sources[value.sources.indexOf(s)]).source;
    const parts=no=>{const c=source.claims.find(c=>c.claimNo===no);return c.parts?c.parts.map(p=>p.text):c.segments?c.segments.map(s=>Array.isArray(s)?s[1]:s.text):[c.text];};
    if(s.facts.some(f=>!source.claims.some(c=>c.claimNo===f.claimNo)))throw Error("fictional_locator_invalid");
    const claims=source.claims.map(c=>{
    let at=0;const ranges=parts(c.claimNo).map(text=>{const start=at;at+=text.length;return[start,at];});
    const facts=s.facts.filter(f=>f.claimNo===c.claimNo).map(f=>{
      const text=parts(c.claimNo).join(""),locators=[],positions=[];
      if(f.basis.length!==1)throw Error("fictional_basis_requires_single_range");
      const selected=f.basis[0];
      if(!Array.isArray(selected)||selected.length!==2||selected.some(n=>!Number.isSafeInteger(n))||
        selected[0]<0||selected[1]<=selected[0]||selected[1]>at)throw Error("fictional_locator_invalid");
      const firstPart=ranges.findIndex(r=>r[0]===selected[0]),lastPart=ranges.findIndex(r=>r[1]===selected[1]);
      if(firstPart<0||lastPart<firstPart)throw Error("fictional_basis_not_part_range");
      const basis={firstPart,lastPart};
      const add=range=>{
        if(!Array.isArray(range)||range.length!==2||range.some(n=>!Number.isSafeInteger(n))||
          range[0]<0||range[1]<=range[0]||range[1]>text.length)throw Error("fictional_locator_invalid");
        const prior=positions.findIndex(r=>r[0]===range[0]&&r[1]===range[1]);if(prior>=0)return prior;
        const [a,b]=[0,text.length];
        if(range[0]<selected[0]||range[1]>selected[1])throw Error("fictional_locator_outside_basis");
        if(range[0]<a||range[1]>b)throw Error("fictional_locator_outside_basis");
        const quote=text.slice(...range),anchor=text.slice(a,b);
        if(!quote.length)throw Error("fictional_locator_invalid");
        const boundary=p=>!(/[\uD800-\uDBFF]/u.test(anchor[p-1]??"")&&/[\uDC00-\uDFFF]/u.test(anchor[p]??""));
        let left=range[0]-a,right=range[1]-a,before="",after="",edge="none";
        const unique=(l,r)=>{const x=anchor.slice(l,r);return boundary(l)&&boundary(r)&&anchor.indexOf(x)===l&&anchor.indexOf(x,l+1)<0;};
        if(!unique(left,right)){
          // Only an explicitly selected edge constrains the first/last match.
          // This inverse consumes hand-authored spans, never a real response.
          if(left<=32){before=anchor.slice(0,left);edge="start";}
          else if(anchor.length-right<=32){after=anchor.slice(right);edge="end";}
          else{
            while(!unique(left,right)){if(left>0)left--;if(right<anchor.length)right++;}
            while(left<range[0]-a&&unique(left+1,right))left++;
            while(right>range[1]-a&&unique(left,right-1))right--;
            before=anchor.slice(left,range[0]-a);after=anchor.slice(range[1]-a,right);
          }
        }
        positions.push(range);locators.push({quote,before,after,edge});return locators.length-1;
      };
      const encoded=fact({...f,basis:[],bindings:[]},add),m=f.meaning;
      const usedTerms=new Set();
      if(new Set(f.bindings.map(b=>b.term)).size!==f.bindings.length)throw Error("fictional_binding_duplicate");
      const term=value=>{
        const binding=f.bindings.find(b=>b.term===value);
        if(!binding)throw Error("fictional_binding_missing");
        const refs=binding.spans.map(add);
        if(refs.map(i=>locators[i].quote).join("")!==value)throw Error("fictional_binding_changed");
        usedTerms.add(value);return refs;
      };
      const common={...m,subject:m.subject===null?null:term(m.subject),
        guard:{...m.guard,conditions:m.guard.conditions.map(term)}};
      const meaning=m.kind==="set"?{...common,members:m.members.map(term)}:m.kind==="path"?
        {...common,origin:m.origin===null?null:term(m.origin),destination:m.destination===null?null:term(m.destination),via:m.via.map(term),bypass:m.bypass.map(term)}:
        {...common,objects:m.objects.map(term)};
      if(usedTerms.size!==f.bindings.length)throw Error("fictional_binding_unused");
      const direct=i=>locators[i];
      const dereference=v=>v===null?null:typeof v==="number"?direct(v):
        Array.isArray(v)?v.map(dereference):v&&typeof v==="object"?
          Object.fromEntries(Object.entries(v).map(([k,x])=>[k,dereference(x)])):v;
      delete encoded.bindings;
      return {...encoded,basis,meaning:dereference(meaning),
        operators:Object.values(encoded.operators).every(v=>v===null)?null:dereference(encoded.operators),
        routeFrame:dereference(encoded.routeFrame)};
    });return {claimNo:c.claimNo,facts,unresolved:facts.length?null:
      {quote:parts(c.claimNo).join(""),before:"",after:"",edge:"none",reason:"Fictional fixture supplies no expressible additional fact."}};
    });return {sourceDigest:s.sourceDigest,coverage:claims.map(({claimNo,unresolved})=>({claimNo,unresolved})),
      facts:claims.flatMap(c=>c.facts)};
  })}));
  if(input.task==="review")return flattenGuards({...value,locatorVersion:1,targets:value.targets.map(target=>{
    const t=table(()=>input.originals.targets.find(x=>x.id===target.id).text),add=r=>t.add(r);
    const parts=target.parts.map(p=>({...p,span:add(p.span),atoms:p.atoms.map(a=>({...fact(a,add),attribution:a.attribution===null?null:add(a.attribution)})),
      reservation:p.reservation?{...p.reservation,basis:add(p.reservation.basis)}:null}));
    return {...target,locators:t.locators,parts};
  })});
  return flattenGuards(value);
}
const textOf = c => c.text ?? c.segments.map(s => Array.isArray(s) ? s[1] : s.text).join("");
const span = (text, term) => { const at=text.indexOf(term);if(at<0)throw Error("fictional_term_missing");return [at,at+term.length]; };
const neutral = {selection:null,extent:null,polarity:null,guard:null,context:null};
const plain = (subject,predicate,objects,guard={relation:"unconditional",conditions:[]}) =>
  ({kind:"relation",subject,context:"capability",guard,polarity:"positive",predicate,objects});
function meanings(text){
  if(text.includes("青色弁")){
    const condition=text.includes("温度が七度を下回る")?"温度が七度を下回る":"温度が七度を超える";
    return [plain("装置","has",["青色弁"]),plain("装置",text.includes("下回ると青色弁を開く")?"opens":"closes",["青色弁"],{relation:"when",conditions:[condition]})];
  }
  const object=text.match(/赤色信号|青色信号|温度|熱/)?.[0]??text.slice(0,Math.min(12,text.length));
  return [plain(null,"has",[object])];
}
const terms = m => [...new Set([...(m.subject?[m.subject]:[]),...m.guard.conditions,...m.objects])];
function extraction(text,m,basis=[0,text.length]){
  return {basis:[basis],meaning:m,bindings:terms(m).map(term=>({term,spans:[span(text,term)]})),
    operators:{...neutral,guard:m.guard.conditions.length?span(text,m.guard.conditions[0]):null},routeFrame:null};
}
const sentence = m => `${m.guard.conditions.length?`${m.guard.conditions.join("・")}場合、`:""}${m.subject??"装置"}は${m.objects.join("・")}${m.predicate==="has"?"を備える":m.predicate==="opens"?"を開く":"を閉じる"}`;
export function fixturePropositionSource(input){
  input={...input,sources:input.sources.map(s=>({...s,source:{...s.source,claims:s.source.claims.map(c=>c.clauses?{...c,text:c.clauses.map(p=>p[1]).join("")}:c.grid?{...c,text:fixtureGridText(c)}:c.parts?{...c,text:c.parts.map(p=>p.text).join("")}:c)}}))};
  return withInput({sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,facts:s.source.claims.flatMap(c=>meanings(textOf(c)).map(m=>{
    const text=textOf(c),f=extraction(text,m);
    // The fictional model explicitly selects the complete claim's part range.
    // No original text is repeated in the basis wire, and no role fills it in.
    return {claimNo:c.claimNo,...f};
  }))}))},input);
}
export function fixturePropositionGeneration(input){
  const result=(d,p)=>{
    const b=input.base.claims.find(c=>c.claimNo===p.baseClaimNo),c=d.candidate.claims.find(c=>c.claimNo===p.candidateClaimNo);
    const bm=meanings(textOf(b)),cm=meanings(textOf(c));
    const shared=meanings(textOf(d.candidate.claims[0]))[0];
    const both=(x,y)=>`基準側の${sentence(x)}。候補側の${sentence(y)}。`;
    return {docId:d.candidateId,baseClaimNo:p.baseClaimNo,candidateClaimNo:p.candidateClaimNo,
      baseObservation:`基準側の${sentence(bm.at(-1))}。`,candidateObservation:`候補側の${sentence(cm.at(-1))}。`,
      common:both(bm[0],shared),differences:both(bm.at(-1),cm.at(-1)),unconfirmed:"作用の対応は未確認。",
      baseEvidenceId:b.segments.filter(s=>s.quotable).at(-1).id,candidateEvidenceId:c.segments.filter(s=>s.quotable).at(-1).id};
  };
  return {results:input.documents.flatMap(d=>d.pairs.map(p=>result(d,p)))};
}
export function fixturePropositionTarget(input){
  if(input.facts?.version===2){const table=input.facts;input={...input,facts:table.rows.map(([id,claimNo,basis,kind,subject])=>
    ({id,claimNo,basis:table.bases[basis],kind:["set","path","relation"][kind],subject:subject===null?null:table.subjects[subject]}))};}
  if(input.factColumns)input={...input,facts:input.facts.map(row=>Object.fromEntries(input.factColumns.map((name,i)=>[name,row[i]])))};
  if(input.textParts){
    const expand=source=>({...source,claims:source.claims.map(c=>({...c,text:c.segments.map(([,i])=>input.textParts[i]).join("")}))});
    input={...input,originals:{...input.originals,base:expand(input.originals.base),documents:input.originals.documents.map(d=>({...d,source:expand(d.source)}))}};
  }
  const original=input.originals;
  const factMeaning=(id,scope)=>{
    const f=input.facts.find(f=>f.id===id),candidate=scope.startsWith("candidate:");
    const source=candidate?original.documents.find(d=>d.docId===Number(scope.split(":")[1])).source:original.base;
    const c=source.claims.find(c=>c.claimNo===f.claimNo),ms=meanings(textOf(c));
    // Fact ordinals are in the original source order, not a model verdict.
    const sameClaim=input.facts.filter(x=>x.id.startsWith(id.split(".")[0]+".")&&x.claimNo===f.claimNo);
    return ms[sameClaim.findIndex(x=>x.id===id)];
  };
  return withInput({draftDigest:input.draftDigest,targets:original.targets.map(t=>{
    const [docId,bno,cno,field]=t.id.split(":"),parts=[];let cursor=0;
    for(const unit of t.text.match(/[^。]*。|[^。]+$/gu)??[]){
      const end=cursor+unit.length;
      if(field==="unconfirmed")parts.push({span:[cursor,end],form:"reservation",atoms:[],reference:null,
        reservation:{topic:"作用の対応",basis:[cursor,cursor+"作用の対応".length]}});
      else{
        const candidate=unit.startsWith("候補"),scope=candidate?`candidate:${docId}:${cno}`:`base:${bno}`;
        const table=input.scopes.find(s=>s.id===scope);
        const fact=input.facts.filter(f=>table.factIds.includes(f.id))
          .find(f=>sentence(factMeaning(f.id,scope))===unit.slice("基準側の".length,-1));
        if(!fact)throw Error("fictional_fact_missing");
        const m=factMeaning(fact.id,scope);
        const raw=extraction(unit,m,[0,unit.length]);
        const shift=([a,b])=>[a+cursor,b+cursor];
        raw.basis=raw.basis.map(shift);raw.bindings=raw.bindings.map(b=>({...b,spans:b.spans.map(shift)}));
        raw.operators=Object.fromEntries(Object.entries(raw.operators).map(([k,s])=>[k,s?shift(s):null]));
        parts.push({span:[cursor,end],form:"assertion",atoms:[{...raw,scope,claimNo:fact.claimNo,attribution:[cursor,cursor+3],sourceIds:[fact.id]}],reference:null,reservation:null});
      }
      cursor=end;
    }
    return {id:t.id,parts};
  })},input);
}
