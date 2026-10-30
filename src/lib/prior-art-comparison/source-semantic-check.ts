import type { Span } from "./propositions";
import type { SourceReadingClaim } from "./source-clause-coverage";
import {isLiteralSourceState,isLiteralComponentType,SOURCE_STATE_PATTERN} from "./literal-source-state";

const invalid=()=>new Error("comparison_source_semantic_incomplete");
const contains=([a,b]:Span,[x,y]:Span)=>a<=x&&b>=y;
const overlaps=([a,b]:Span,[x,y]:Span)=>a<y&&b>x;
export type SourceActionCue={span:Span;clause:number;predicate:string;polarity:"positive"|"negative"};

/** A narrow, literal reading checklist. These are occurrences of action words,
 * not inferred propositions. Nouns such as 放熱器/開閉弁 are not action cues.
 * Context, actor, polarity and guard still come from independently checked AI
 * facts; this helper never constructs or repairs them. */
export function sourceActionCues(c:SourceReadingClaim):SourceActionCue[]{
  const cues:SourceActionCue[]=[];
  for(const [predicate,pattern] of [
    ["releases_heat",/放熱(?:させ(?:ていなかった|ていない|なかった|ない|ず)?|していなかった|していない|しなかった|しない|せず|する|し(?=[、。]))/gu],
    ["absorbs_heat",/吸熱(?:させ(?:ていなかった|ていない|なかった|ない|ず)?|していなかった|していない|しなかった|しない|せず|する|し(?=[、。]))/gu],
    ["generates_heat",/発熱(?:させ(?:ていなかった|ていない|なかった|ない|ず)?|していなかった|していない|しなかった|しない|せず|する|し(?=[、。]))/gu],
    ["closes",/閉じ(?:ていなかった|ていない|なかった|ない|ず|る|て(?!い)|た(?=状態)|(?=[、，]))/gu],
    ["fully_closes",/全閉(?:(?:に|と)?し(?:ていなかった|ていない|なかった|ない)|にする|とする|にし(?!な|てい)|とし(?!な|てい)|する|した|となる)/gu],
  ] as const)for(const match of c.grid.text.matchAll(pattern)){
    const complete=predicate==="closes"&&c.grid.text.slice(Math.max(0,match.index-3),match.index)==="完全に";
    const tail=textTail(c.grid.text,match.index+match[0].length);
    const span:Span=[match.index-(complete?3:0),match.index+match[0].length+tail.length];
    const clause=c.clauses.findIndex(s=>contains(s,span));if(clause<0)throw invalid();
    cues.push({span,clause,predicate:complete?"fully_closes":predicate,polarity:tail.length||/(?:ない|なかった|ず)$/u.test(match[0])?"negative":"positive"});
  }
  return cues.sort((a,b)=>a.span[0]-b.span[0]);
}

// Extend only explicit printed nominalized negation, not inferred modality.
function textTail(text:string,end:number):string{
  return /^(?:る)?こと(?:は|が|も)(?:なかった|ない)/u.exec(text.slice(end))?.[0]??"";
}

/** Additional v19 literal opening occurrences. A named valve or a temporal
 * prerequisite (開いた後) is not a new opening. No actor/condition is inferred. */
export function sourceCompleteActionCues(c:SourceReadingClaim):SourceActionCue[]{
  const cues=sourceActionCues(c),text=c.grid.text;
  // These literal tails describe a premise, negation or modality; they do not
  // assert the matched state/action. Leave ambiguous prose to original QA.
  const unasserted=(end:number,clause:number)=>/^(?:ない|なかった|ず|ていない|ていなかった|ません|な(?:[。！、]|$)|必要|と(?=[、，])|れば|ても|たら|こと(?:は|が|も|なく)|(?:状態)?(?:の)?(?:場合|とき|時|際|なら|後))/u.test(text.slice(end,c.clauses[clause][1]));
  const allStates=[...text.matchAll(SOURCE_STATE_PATTERN)].filter(m=>!isLiteralComponentType(m[0])||!/[「」『』“”"]/u.test(text)).map(m=>{
    const span:Span=[m.index,m.index+m[0].length],clause=c.clauses.findIndex(s=>contains(s,span));if(clause<0)throw invalid();
    return {span,clause,predicate:"is_state",polarity:"positive" as const};
  });
  // Recognize only clear assertion endings, plus a directly modified katakana
  // component name. Unknown inflections/conditions remain original-QA work;
  // they never force a positive state from an arbitrary matched prefix.
  const states=allStates.filter(s=>/^(?:[、，。]|$|ことを特徴)/u.test(text.slice(s.span[1]))||
    isLiteralComponentType(text.slice(...s.span))&&/^と共に[、，]/u.test(text.slice(s.span[1],c.clauses[s.clause][1]))||
    /接続された$/u.test(text.slice(...s.span))&&/^[\p{Script=Katakana}ー]+(?:と|を|が|は)(?:[、，。]|$)/u.test(text.slice(s.span[1],c.clauses[s.clause][1]))||
    // A passive placement may directly define a printed component. Require a
    // bounded component noun and list/subject ending, never a condition tail.
    /に設けられ(?:た|る)$/u.test(text.slice(...s.span))&&isLiteralSourceState(text.slice(...s.span))&&
      /^[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９Ａ-Ｚａ-ｚー]*(?:器|弁|配管|装置|センサ|アキュムレータ)(?:と|を|が|は)(?:[、，。]|$)/u.test(text.slice(s.span[1],c.clauses[s.clause][1])));
  const pattern=/(?:同時に|(?:何れか|いずれか)?一方を)?開(?:いていなかった|いていない|かなかった|かない|かず|きません|くこと(?:は|が|も)(?:なかった|ない)|くことなく|く|き(?=[、，])|いた(?=状態を維持))/gu;
  for(const m of text.matchAll(pattern)){
    const span:Span=[m.index,m.index+m[0].length],clause=c.clauses.findIndex(s=>contains(s,span));if(clause<0)throw invalid();
    if(unasserted(span[1],clause))continue;
    cues.push({span,clause,predicate:m[0].startsWith("同時に")?"opens_together":m[0].includes("一方を")?"opens_one":"opens",
      polarity:/(?:ない|なかった|ず|ません|なく)$/u.test(m[0])?"negative":"positive"});
  }
  return [...cues.filter(cue=>!allStates.some(s=>contains(s.span,cue.span))),...states].sort((a,b)=>a.span[0]-b.span[0]);
}

/** v20 also lists printed component functions missed by the earlier heat/valve
 * checklist. It supplies occurrence locations only, never subjects, objects or
 * completed meanings. Conditional premises and bare equipment nouns do not
 * assert a new function. Original-source QA remains necessary. */
export function sourceFullActionCues(c:SourceReadingClaim):SourceActionCue[]{
  const cues=sourceCompleteActionCues(c),text=c.grid.text;
  const pattern=/(?:圧縮|減圧|加熱|冷却|検出|出力|流通)(?:していなかった|していない|しなかった|しない|せず|する|して|した|し(?=[、，]))/gu;
  for(const match of text.matchAll(pattern)){
    const end=match.index+match[0].length;
    const tail=textTail(text,end),span:Span=[match.index,end+tail.length];
    const clause=c.clauses.findIndex(s=>contains(s,span));if(clause<0)throw invalid();
    const rest=text.slice(span[1],c.clauses[clause][1]);
    if(/^(?:(?:状態)?(?:の)?(?:場合|とき|時|際|なら|後)|と(?=[、，])|ても|たら|必要|こと(?:は|が|も|なく|を禁止)|ものでは|のであれば)/u.test(rest))continue;
    const negative=tail.length>0||/(?:ない|なかった|ず)$/u.test(match[0]);
    if(!negative&&/する$/u.test(match[0])&&!/^(?:[、，。]|$|ための|[\p{Script=Han}\p{Script=Katakana}ー]{0,40}(?:機|器|装置|通路|センサ)(?:と|を備|[、，。]|$))/u.test(rest))continue;
    // An unmatched past/te-form alone is not an asserted function. Permit the
    // explicit connecting forms and capability definitions actually printed.
    if(/した$/u.test(match[0])&&!/^[、，。]/u.test(rest))continue;
    if(/して$/u.test(match[0])&&(/^(?:い|お|から|は|も)/u.test(rest)||!/^[^、，。]*する(?:[\p{Script=Han}\p{Script=Katakana}ー]{0,40}(?:機|器|装置|通路|センサ)(?:と|を備))?[、，。]?$/u.test(rest)||/(?:場合|とき|なら|のであれば|禁止|必要|ではない)/u.test(rest)))continue;
    cues.push({span,clause,predicate:"executes",polarity:negative?"negative":"positive"});
  }
  return cues.sort((a,b)=>a.span[0]-b.span[0]);
}

export type SourceOrGroup={branches:Span[];span:Span};
/** Recognize only punctuation-delimited timing alternatives whose branch ends
 * are explicit. No guessed condition boundary or general Japanese parsing. */
export function sourceOrGroups(c:SourceReadingClaim):SourceOrGroup[]{
  const text=c.grid.text,groups:SourceOrGroup[]=[];
  const connector=(id:number)=>/^(?:又は|若しくは|または|あるいは)[、，]?$/u.test(text.slice(...c.clauses[id]).trim());
  const branch=(id:number):Span|null=>{
    const s=c.clauses[id];if(!s)return null;
    const value=text.slice(...s),match=/^(.+?(?:後|場合|とき|時))(?:には|に|は|で|、|，|$)/u.exec(value);
    return match?[s[0],s[0]+match[1].length]:null;
  };
  for(let id=1;id<c.clauses.length-1;id++){
    if(!connector(id))continue;
    const first=branch(id-1),next=branch(id+1);if(!first||!next)continue;
    const branches=[first,next];let last=id+1;
    while(last+2<c.clauses.length&&connector(last+1)){
      const b=branch(last+2);if(!b)break;branches.push(b);last+=2;
    }
    groups.push({branches,span:[first[0],branches.at(-1)![1]]});id=last;
  }
  return groups;
}

export type CheckedSourceFact={
  kind:string;predicate?:string;polarity:string;polarityProof:Span|null;action:Span|null;evidence:Span[];
  objectSpans:Span[][];guardSpans:Span[][];guardProof:Span|null;
  // Same meaning except the branch conditions. Includes actor/context/polarity
  // and the action occurrence, so unrelated facts cannot complete a group.
  identity:string;
};
export function assertSourceSemanticReading(c:SourceReadingClaim,facts:CheckedSourceFact[],cues=sourceActionCues(c),requireAllOrGroups=true){
  const text=c.grid.text;
  for(const fact of facts){
    if(fact.kind!=="relation")continue;
    if(!fact.action)throw invalid();
    const action=text.slice(...fact.action);
    if(fact.predicate==="is_state"&&(!isLiteralSourceState(action)||fact.objectSpans.length!==1||fact.objectSpans[0].length!==1||
      !contains(fact.objectSpans[0][0],fact.action)||!isLiteralSourceState(text.slice(...fact.objectSpans[0][0]))))throw invalid();
    // A close cannot be accepted as stopping merely because both its noun and
    // its broad W happen to quote the source. Preserve the exact action word.
    const local=cues.filter(cue=>contains(fact.action!,cue.span));
    // The literal checklist is partial. An AI-supplied placement can directly
    // define a numbered component without being a checklist obligation. Check
    // this exact occurrence and assertion ending; never supply a missing fact.
    const numberedPlacement=/に設けられ(?:た|る)$/u.test(action)&&
      /^第[0-9０-９]+の[\p{Script=Han}\p{Script=Katakana}A-Za-z0-9０-９Ａ-Ｚａ-ｚー]*(?:器|弁|配管|装置|センサ|アキュムレータ)(?:と|を|が|は)(?:[、，。]|$)/u.test(text.slice(fact.action[1]));
    // A coordinated passive assertion is also explicit. Keep the exact state
    // and location checks above; a conditional or negative suffix cannot pass.
    const placementClause=c.clauses.find(s=>contains(s,fact.action!));
    const coordinatedPlacement=action.endsWith("に設けられる")&&!!placementClause&&
      /^と共に[、，]/u.test(text.slice(fact.action[1],placementClause[1]));
    if(fact.predicate==="is_state"&&!local.some(cue=>cue.predicate==="is_state")&&!numberedPlacement&&!coordinatedPlacement)throw invalid();
    if(fact.predicate==="stops"&&(!/(?:停止|中止|終了|止め)/u.test(action)||local.length))throw invalid();
    if(["closes","fully_closes","releases_heat","absorbs_heat","generates_heat",...(cues.some(c=>c.predicate.startsWith("opens"))?["opens","opens_one","opens_together"]:[])].includes(fact.predicate!)){
      if(!local.length||local.some(cue=>cue.predicate!==fact.predicate||cue.polarity!==fact.polarity))throw invalid();
    }
  }
  for(const cue of cues){
    const clause=c.clauses[cue.clause];
    if(!facts.some(f=>{
      if(f.kind!=="relation"||!f.action||!contains(f.action,cue.span))return false;
      if(f.predicate===cue.predicate){
        if(f.polarity!==cue.polarity||cue.polarity==="negative"&&(!f.polarityProof||!contains(f.polarityProof,cue.span)))return false;
        // A bounded component-name check, not general noun-role inference.
        // For the explicitly named equipment families, reject 冷媒/にて and
        // action words as heat objects. Other names still require original QA.
        const component=/(?:熱交換器|放熱器|吸熱器|加熱器|冷却器|加熱装置|発熱体|ヒーター?)/u;
        const named=component.test(text.slice(...clause));
        return !cue.predicate.endsWith("heat")||f.objectSpans.some(term=>term.some(s=>overlaps(s,clause)&&
          !overlaps(s,cue.span)&&(!named||component.test(text.slice(...s)))));
      }
      // A quoted closed state being maintained is not a new closing event.
      return ["opens","closes","fully_closes"].includes(cue.predicate)&&f.predicate==="maintains"&&/維持/u.test(text.slice(...f.action))&&
        f.objectSpans.some(term=>term.some(s=>contains(s,cue.span)));
    }))throw invalid();
  }
  for(const group of sourceOrGroups(c)){
    const related=facts.filter(f=>f.guardSpans.flat().some(s=>overlaps(s,group.span))||
      f.guardProof&&contains(f.guardProof,group.span));
    // An explicitly delimited condition list cannot disappear while W alone
    // claims it was read. This rejects absence; it does not create its action.
    if(!related.length){
      // A preplanned part may not own the assertion governed by this group.
      // Completeness is still mandatory on the unchanged complete-source union.
      if(requireAllOrGroups)throw invalid();
      continue;
    }
    const branchFacts=new Map<string,Set<number>>();
    for(const f of related){
      const whole=f.guardSpans.filter(term=>term.length===1&&contains(term[0],group.span));
      if(whole.length===1){
        if(f.guardSpans.some(term=>term!==whole[0]&&term.some(s=>overlaps(s,group.span))))throw invalid();
        continue;
      }
      const selected=group.branches.flatMap((b,i)=>f.guardSpans.some(term=>term.length===1&&contains(term[0],b))?[i]:[]);
      // Multiple alternatives in the conjunctive G are not an OR.
      if(selected.length!==1||!f.guardProof||!contains(f.guardProof,group.span))throw invalid();
      const shared=f.guardSpans.filter(term=>!term.some(s=>overlaps(s,group.span)));
      if(f.guardSpans.some(term=>term.some(s=>overlaps(s,group.span))&&
          !(term.length===1&&contains(term[0],group.branches[selected[0]]))))throw invalid();
      const key=JSON.stringify([f.identity,shared]);
      if(!branchFacts.has(key))branchFacts.set(key,new Set());branchFacts.get(key)!.add(selected[0]);
    }
    if([...branchFacts.values()].some(branches=>branches.size!==group.branches.length))throw invalid();
  }
}
