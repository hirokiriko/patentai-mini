// Fully fictional SDK responses. Hand-authored semantic extraction is test
// plumbing only and must never be reported as real-model extraction quality.
export function fixturePropositionWire(value) {
  if (Array.isArray(value)) return value.map(fixturePropositionWire);
  if (!value || typeof value !== "object") return value;
  const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fixturePropositionWire(child)]));
  if (row.guard && ["set", "path", "relation"].includes(String(row.kind))) {
    const guard = row.guard;
    delete row.guard; row.guardRelation = guard.relation; row.guardConditions = guard.conditions;
  }
  return row;
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
  if(input.textParts)input={...input,sources:input.sources.map(s=>({...s,source:{...s.source,claims:s.source.claims.map(c=>({...c,text:c.parts.map(i=>input.textParts[i]).join("")}))}}))};
  return {sources:input.sources.map(s=>({sourceDigest:s.sourceDigest,facts:s.source.claims.flatMap(c=>meanings(textOf(c)).map(m=>({claimNo:c.claimNo,...extraction(textOf(c),m)})))}))};
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
  return {draftDigest:input.draftDigest,targets:original.targets.map(t=>{
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
  })};
}
