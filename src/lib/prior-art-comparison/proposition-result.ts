import type { z } from "zod";
import { ComparisonError } from "./source";
import { compareProposition, explainProposition, propositionKey, meaningKey, type Meaning, type PropositionComparison } from "./propositions";
import { coversReferenceScope } from "./proposition-references";
import { decodeTargetPropositions, type PropositionTargetInput, type targetPropositionSchema } from "./proposition-extraction";
import { REVIEW_FIELDS, reviewTargetIdentity, type ReviewDraft } from "./semantic-review";

export type PropositionAssessment = ReturnType<typeof assessPropositions>;
/** Returns all records, including failures. Diagnostic responses are never
 * repaired, and unsupported extraction does not count as contradiction. */
export function assessPropositions(input:PropositionTargetInput,value:unknown){
  const extracted=decodeTargetPropositions(input,value);
  const records=extracted.atoms.map(t=>compareProposition(t,input.sourcePropositions));
  const coverage=extracted.raw.targets.flatMap(target=>target.parts.flatMap((_part,partIndex)=>{
    const own=records.filter(r=>r.target.id.startsWith(`${target.id}/${partIndex}/`));
    return [...new Set(own.map(r=>r.target.scope))].flatMap(id=>{
      const scope=input.referenceScopes.find(s=>s.id===id),scoped=own.filter(r=>r.target.scope===id);
      return [...new Set(scoped.map(r=>meaningKey(r.target.meaning)))].map(key=>{
        const claims=scoped.filter(r=>r.relation==="entailed"&&meaningKey(r.target.meaning)===key).map(r=>r.target.claimNo);
        return {targetId:target.id,partIndex,scope:id,meaningKey:key,claims,complete:!!scope&&coversReferenceScope(scope,claims)};
      });
    });
  }));
  const targets=extracted.raw.targets.map(t=>{
    const own=records.filter(r=>r.target.targetId===t.id);
    const unexpressed=t.parts.some(p=>p.form==="unresolved")||coverage.some(c=>c.targetId===t.id&&!c.complete);
    return {id:t.id,relation:own.some(r=>r.relation==="contradicted")?"contradicted" as const:
      unexpressed||own.some(r=>r.relation==="unresolved")?"unresolved" as const:own.length?"entailed" as const:"nonassertive" as const,
      records:own.map(r=>({...r,reason:explainProposition(r)}))};
  });
  return {raw:extracted.raw,records,targets,coverage};
}
const list=(values:string[])=>values.join("・");
/** Render the extracted assertion which actually passed the comparison. No
 * model-supplied explanation, verdict, or weaker replacement is consulted. */
export function renderMeaning(m:Meaning):string {
  const subject=m.subject??"装置";
  const condition=m.guard.relation==="unconditional"?"":`条件「${list(m.guard.conditions)}」${m.guard.relation==="only_when"?"を満たす場合に限り":"のとき"}、`;
  if(m.polarity!=="positive"||m.context==="unresolved"||m.guard.relation==="unresolved")throw new ComparisonError("ai_incomplete");
  if(m.kind==="set"){
    const select={required:"を必須とする",one:"のいずれか一つである",nonempty:"のいずれか・組合せ・全てである",all:"を全て必要とする",unspecified:""}[m.selection];
    if(!select)throw new ComparisonError("ai_incomplete");
    return `${condition}${subject}${m.extent==="partial"?`の選択肢には${list(m.members)}が含まれる`:`は${list(m.members)}${select}`}`;
  }
  if(m.kind==="path"){
    if(m.relation==="precedes")return `${condition}${subject}では${list(m.via)}の後に${m.destination}へ流れる`;
    if(!m.origin||!m.destination)throw new ComparisonError("ai_incomplete");
    return `${condition}${subject}では${m.origin}から${m.via.length?`${list(m.via)}をこの順に経て` : ""}${m.bypass.length?`${list(m.bypass)}を経ず` : ""}${m.destination}へ流れる`;
  }
  const objects=list(m.objects);
  const action={has:`${objects}を備える`,upstream:`${objects}の上流にある`,downstream:`${objects}の下流にある`,inside:`${objects}内にある`,
    opens:`${objects}を開く`,closes:`${objects}を閉じる`,maintains:`${objects}を維持する`,at_least:`${objects}以上である`,
    at_most:`${objects}以下である`,greater_than:`${objects}を超える`,less_than:`${objects}を下回る`}[m.predicate];
  return `${condition}${subject}は${action}`;
}

function renderPart(part:z.infer<typeof targetPropositionSchema>["targets"][number]["parts"][number],records:PropositionComparison[],originalText:string):string[] {
  const statements=records.map(r=>`${r.target.scope.startsWith("base:")?"基準側":"候補側"}の${renderMeaning(r.target.meaning)}。`);
  if(part.form==="reference"&&part.reference)statements.push(`${part.reference.side==="base"?"基準側":"候補側"}の参照範囲は請求項${part.reference.claimNos.join("・")}${originalText.slice(...part.span).includes("まで")?"までの引用関係":"の引用関係"}。`);
  if(part.form==="reservation"&&part.reservation)statements.push(`未確認事項：${part.reservation.topic.replace(/[。]+$/u,"")}。`);
  return statements;
}
function comparisonSentences(field:"common"|"differences",records:PropositionComparison[]):string[]{
  const unique=(side:string)=>[...new Map(records.filter(r=>r.target.scope.startsWith(side)).map(r=>[meaningKey(r.target.meaning),r.target.meaning])).values()];
  const base=unique("base:"),candidates=unique("candidate:");
  if(!base.length||!candidates.length)throw new ComparisonError("ai_incomplete");
  const used=new Set<number>(),sentences:string[]=[];
  const matches=new Map<number,number>();
  const compatible=(b:Meaning,c:Meaning)=>b.kind===c.kind&&b.context===c.context&&propositionKey(b.subject??"")===propositionKey(c.subject??"");
  const sameMembers=(b:Meaning,c:Meaning)=>b.kind==="set"&&c.kind==="set"&&JSON.stringify(b.members.map(propositionKey).sort())===JSON.stringify(c.members.map(propositionKey).sort());
  // Match all exact counterparts before using a weaker correspondence. Source
  // order cannot turn identical assertions into unrelated differences.
  for(const match of [(b:Meaning,c:Meaning)=>meaningKey(b)===meaningKey(c),sameMembers,...(field==="differences"?[(b:Meaning,c:Meaning)=>compatible(b,c)]:[])]){
    for(const [i,b] of base.entries())if(!matches.has(i)){
      const at=candidates.findIndex((c,j)=>!used.has(j)&&compatible(b,c)&&match(b,c));
      if(at>=0){matches.set(i,at);used.add(at);}
    }
  }
  for(const [i,b] of base.entries()){
    const at=matches.get(i);if(at===undefined)throw new ComparisonError("ai_incomplete");const c=candidates[at];
    const equal=meaningKey(b)===meaningKey(c);
    if(field==="common"){
      if(!equal&&!sameMembers(b,c))throw new ComparisonError("ai_incomplete");
      // A shared option is not a shared mandatory requirement. Keep the two
      // quantifiers and subjects when the computed correspondence is partial.
      sentences.push(equal?`両側とも、${renderMeaning(b)}。`:`対応候補：基準側の${renderMeaning(b)}。候補側の${renderMeaning(c)}。`);
    }else sentences.push(equal?`対応づけた条件は一致する（${renderMeaning(b)}）。`:`基準側の${renderMeaning(b)}。候補側の${renderMeaning(c)}。`);
  }
  if(used.size!==candidates.length)throw new ComparisonError("ai_incomplete");
  return sentences;
}

/** The immutable save-v1 adapter receives only sentences built from these
 * records. Refuse overflow; never truncate, delete conditions, or fall back to
 * the generated free text. Each branch must have the same rendered statement
 * before deduplicating identical sentences. */
export function renderPropositionDrafts(input:PropositionTargetInput,assessment:PropositionAssessment,drafts:readonly ReviewDraft[]):ReviewDraft[]{
  if(assessment.targets.some(t=>t.relation!=="entailed"&&t.relation!=="nonassertive"))throw new ComparisonError("ai_incomplete");
  return drafts.map(d=>{
    const result={...d};
    for(const field of REVIEW_FIELDS){
      const id=`${d.docId}:${d.baseClaimNo}:${d.candidateClaimNo}:${field}`;
      const answer=assessment.raw.targets.find(t=>t.id===id);if(!answer)throw new ComparisonError("ai_incomplete");
      const records=assessment.records.filter(r=>r.target.targetId===id);
      if((field==="baseObservation"||field==="candidateObservation")&&!records.length)throw new ComparisonError("ai_incomplete");
      const statements=field==="common"||field==="differences"?[
        ...comparisonSentences(field,records),
        ...answer.parts.filter(p=>p.form!=="assertion").flatMap(p=>renderPart(p,[],d[field])),
      ]:answer.parts.flatMap((p,partIndex)=>renderPart(p,records.filter(r=>r.target.id.startsWith(`${id}/${partIndex}/`)),d[field]));
      const text=[...new Set(statements)].join("");
      const limit=field==="common"||field==="differences"?200:120;
      if(!text||text.length>limit)throw new ComparisonError("ai_incomplete");
      result[field]=text;
    }
    return result;
  });
}

export function assertPropositionTargetCoverage(input:PropositionTargetInput,assessment:PropositionAssessment):void {
  // An assertion about a selected scope must be checked in every alternative,
  // not just in the branch most favorable to the proposed statement.
  if(assessment.coverage.some(c=>!c.complete))throw new ComparisonError("ai_incomplete");
  for(const target of assessment.raw.targets){
    const identity=reviewTargetIdentity(target.id);
    const pair=input.originals.pairs.find(p=>p.docId===identity.docId&&p.baseClaimNo===identity.baseClaimNo&&p.candidateClaimNo===identity.candidateClaimNo)!;
    for(const [partIndex,part] of target.parts.entries()){
      if(part.form==="assertion"&&!part.atoms.length)throw new ComparisonError("ai_incomplete");
      const records=assessment.records.filter(r=>r.target.id.startsWith(`${target.id}/${partIndex}/`));
      const scopes=[...new Set(records.map(r=>r.target.scope))];
      if((identity.field==="common"||identity.field==="differences")&&part.form==="assertion"&&
        !scopes.every(s=>s===`base:${pair.baseClaimNo}`||s===`candidate:${pair.docId}:${pair.candidateClaimNo}`))throw new ComparisonError("ai_incomplete");
    }
  }
}
