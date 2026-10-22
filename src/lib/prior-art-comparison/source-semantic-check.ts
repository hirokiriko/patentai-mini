import type { Span } from "./propositions";
import type { SourceReadingClaim } from "./source-clause-coverage";

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
export function assertSourceSemanticReading(c:SourceReadingClaim,facts:CheckedSourceFact[]){
  const text=c.grid.text,cues=sourceActionCues(c);
  for(const fact of facts){
    if(fact.kind!=="relation")continue;
    if(!fact.action)throw invalid();
    const action=text.slice(...fact.action);
    // A close cannot be accepted as stopping merely because both its noun and
    // its broad W happen to quote the source. Preserve the exact action word.
    const local=cues.filter(cue=>contains(fact.action!,cue.span));
    if(fact.predicate==="stops"&&(!/(?:停止|中止|終了|止め)/u.test(action)||local.length))throw invalid();
    if(["closes","fully_closes","releases_heat","absorbs_heat","generates_heat"].includes(fact.predicate!)){
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
      return ["closes","fully_closes"].includes(cue.predicate)&&f.predicate==="maintains"&&/維持/u.test(text.slice(...f.action))&&
        f.objectSpans.some(term=>term.some(s=>contains(s,cue.span)));
    }))throw invalid();
  }
  for(const group of sourceOrGroups(c)){
    const related=facts.filter(f=>f.guardSpans.flat().some(s=>overlaps(s,group.span))||
      f.guardProof&&contains(f.guardProof,group.span));
    // An explicitly delimited condition list cannot disappear while W alone
    // claims it was read. This rejects absence; it does not create its action.
    if(!related.length)throw invalid();
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
