import type {SourceReadingClaim} from "./source-clause-coverage";
import {sourceActionCues} from "./source-semantic-check";
import {resolveSourceContextQuote} from "./source-direct-quotes";
import {sourceCellRef} from "./source-citation-grid";
import type {Span} from "./propositions";

const invalid=()=>new Error("comparison_source_reading_task_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export type SourceReadingTask={clause:number;kind:string;span:Span;polarity:string};

/** Literal occurrences, never supplied propositions. In particular a component
 * definition, location or negative flow does not force an invented route. */
export function sourceReadingTasks(c:SourceReadingClaim):SourceReadingTask[]{
  const tasks:SourceReadingTask[]=sourceActionCues(c).map(t=>({...t,kind:t.predicate}));
  c.clauses.forEach((span,clause)=>{
    const text=c.grid.text.slice(...span);
    // Conservatively leave any negated clause to full original QA. A reading
    // obligation must never require a positive route from a prohibition,
    // past/polite negation or absence of necessity.
    if(/冷媒を.+に(?:直接)?(?:流し|流す|流入させ)/u.test(text)&&
      !/ための|ない|なかった|なく|無く|無い|ません|ず/u.test(text))
      tasks.push({clause,kind:"path",span,polarity:"positive"});
  });
  return tasks.sort((a,b)=>a.span[0]-b.span[0]||a.span[1]-b.span[1]);
}

export function sourceConsecutiveIds(c:SourceReadingClaim,first:unknown,last:unknown,ids:readonly number[]):number[]{
  if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||Number(first)<0||Number(last)<Number(first)||
    !c.clauses[Number(last)]||Number(last)-Number(first)>=12)throw invalid();
  const range=Array.from({length:Number(last)-Number(first)+1},(_,i)=>Number(first)+i);
  if(range.some(id=>!ids.includes(id)))throw invalid();return range;
}

/** Resolve only the named range. This maps an explicit citation to a span;
 * it neither rewrites the quote nor searches another clause or claim. */
export function resolveSourceTaskQuote(c:SourceReadingClaim,v:unknown,ids:readonly number[]):Span{
  let first:unknown,last:unknown,quote:string,before="",after="";
  if(typeof v==="string"){
    const m=/^(0|[1-9]\d*):([\s\S]+)$/u.exec(v);if(!m)throw invalid();
    first=last=Number(m[1]);quote=m[2];
  }else{
    if(!exact(v,["first","last","quote","before","after"])||typeof v.quote!=="string"||!v.quote||typeof v.before!=="string"||typeof v.after!=="string")throw invalid();
    ({first,last,quote,before,after}=v);
  }
  const range=sourceConsecutiveIds(c,first,last,ids),offset=c.clauses[range[0]][0],end=c.clauses[range.at(-1)!][1];
  const local=resolveSourceContextQuote(c.grid.text.slice(offset,end),{quote,before,after,edge:"none"});
  const span:Span=[offset+local[0],offset+local[1]];sourceCellRef(c.grid,span);return span;
}

export function assertSourceTaskBindings(tasks:SourceReadingTask[],selected:unknown,m:Record<string,unknown>,ids:readonly number[],action:Span|null,routePoints:readonly Span[]=[]){
  if(!Array.isArray(selected)||selected.some(id=>!Number.isSafeInteger(id)||id<0||!tasks[id])||new Set(selected).size!==selected.length)throw invalid();
  for(const id of selected){
    const t=tasks[id];if(!ids.includes(t.clause))throw invalid();
    if(t.kind==="path"){
      if(m.k!=="path"||m.r!=="route"||m.p!==t.polarity||!routePoints.some(([a,b])=>a<t.span[1]&&b>t.span[0]))throw invalid();
    }
    else{
      if(m.k!=="relation"||!action||action[0]>t.span[0]||action[1]<t.span[1])throw invalid();
      if(m.P!==t.kind&&!(m.P==="maintains"&&["closes","fully_closes"].includes(t.kind)))throw invalid();
      // The unchanged semantic checker further verifies maintained state,
      // polarity, heat objects and full guards, not just this task reference.
      if(m.p!==t.polarity)throw invalid();
    }
  }
  return selected as number[];
}
