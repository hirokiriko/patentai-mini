import type {SourceReadingClaim} from "./source-clause-coverage";
import {sourceActionCues,sourceCompleteActionCues,sourceFullActionCues} from "./source-semantic-check";
import {resolveSourceContextQuote} from "./source-direct-quotes";
import {sourceCellRef} from "./source-citation-grid";
import type {Span} from "./propositions";

const invalid=()=>new Error("comparison_source_reading_task_invalid");
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:unknown,keys:string[]):v is Record<string,unknown>=>record(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
export type SourceReadingTask={clause:number;kind:string;span:Span;polarity:string};

/** Literal occurrences, never supplied propositions. In particular a component
 * definition, location or negative flow does not force an invented route. */
export function sourceReadingTasks(c:SourceReadingClaim,complete=false,functions=false):SourceReadingTask[]{
  const tasks:SourceReadingTask[]=(functions?sourceFullActionCues(c):complete?sourceCompleteActionCues(c):sourceActionCues(c)).map(t=>({...t,kind:t.predicate}));
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
      if(m.P!==t.kind&&!(m.P==="maintains"&&["opens","closes","fully_closes"].includes(t.kind)))throw invalid();
      // The unchanged semantic checker further verifies maintained state,
      // polarity, heat objects and full guards, not just this task reference.
      if(m.p!==t.polarity)throw invalid();
    }
  }
  return selected as number[];
}

/** v19 records no second copy of the citation inventory. Only locations
 * explicitly declared in the new answer become evidence; no text, actor,
 * condition or missing fact is supplied. Old wire answers are never repaired. */
export function sourceDeclaredEvidence(c:SourceReadingClaim,f:Record<string,unknown>,fixed:readonly Span[]=[]):number[]{
  if(!record(f.m)||Object.hasOwn(f,"W")||Object.hasOwn(f,"T"))throw invalid();
  const ids=new Set<number>();
  const range=(first:unknown,last:unknown)=>{
    if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||Number(first)<0||Number(last)<Number(first)||!c.clauses[Number(last)]||Number(last)-Number(first)>=12)throw invalid();
    for(let id=Number(first);id<=Number(last);id++)ids.add(id);
  };
  const quote=(v:unknown)=>{
    if(typeof v==="string"){
      const m=/^(0|[1-9]\d*):[\s\S]+$/u.exec(v);if(!m)throw invalid();range(Number(m[1]),Number(m[1]));
    }else{
      if(!exact(v,["first","last","quote","before","after"])||typeof v.quote!=="string"||!v.quote||typeof v.before!=="string"||typeof v.after!=="string")throw invalid();
      range(v.first,v.last);
    }
  };
  const term=(v:unknown)=>{if(!Array.isArray(v)||!v.length||v.length>4)throw invalid();v.forEach(quote);};
  for(const k of ["u","i","j"])if(Object.hasOwn(f.m,k)&&f.m[k]!==null)term(f.m[k]);
  for(const k of ["G","M","V","B","J"])if(Object.hasOwn(f.m,k)){
    if(!Array.isArray(f.m[k]))throw invalid();f.m[k].forEach(term);
  }
  if(Object.hasOwn(f.m,"a"))quote(f.m.a);
  const proof=(v:unknown)=>{if(v===null)return;if(exact(v,["first","last"]))range(v.first,v.last);else quote(v);};
  if(!exact(f.O,["selection","extent","polarity","guard","context"]))throw invalid();Object.values(f.O).forEach(proof);
  if(record(f.F)){
    if(!exact(f.F,["E","X","T","C","D"])||!Array.isArray(f.F.C)||!Array.isArray(f.F.D))throw invalid();
    [f.F.E,f.F.X,f.F.T,...f.F.C,...f.F.D].forEach(proof);
  }else if(f.F!==null){
    if(!Number.isSafeInteger(f.F)||!fixed.length)throw invalid();
    for(const [a,b]of fixed)c.clauses.forEach(([x,y],id)=>{if(x<b&&y>a)ids.add(id);});
  }
  if(!ids.size||ids.size>12)throw invalid();return [...ids].sort((a,b)=>a-b);
}

/** Coverage is a relation between an actual fact and a literal task. Removing
 * generated task numbers never adds a meaning or credits an unrelated fact. */
export function sourceMatchedTasks(tasks:SourceReadingTask[],m:Record<string,unknown>,ids:readonly number[],action:Span|null,routePoints:readonly Span[]):number[]{
  return tasks.flatMap((_,id)=>{try{return assertSourceTaskBindings(tasks,[id],m,ids,action,routePoints);}catch{return [];}});
}

/** v20 names a contiguous original range even for a single-clause quote.
 * Conversion records only the supplied location; no quote is searched elsewhere. */
export function sourceOrderedQuote(value:unknown):Record<string,unknown>{
  if(typeof value==="string"){
    const m=/^(0|[1-9]\d*)-(0|[1-9]\d*):([\s\S]+)$/u.exec(value);
    if(!m)throw invalid();
    return {first:Number(m[1]),last:Number(m[2]),quote:m[3],before:"",after:""};
  }
  if(!exact(value,["first","last","quote","before","after"]))throw invalid();
  return {...value};
}
export function resolveSourceOrderedQuote(c:SourceReadingClaim,value:unknown,ids:readonly number[]):Span{
  return resolveSourceTaskQuote(c,sourceOrderedQuote(value),ids);
}
export function sourceDeclaredOrderedEvidence(c:SourceReadingClaim,f:Record<string,unknown>,fixed:readonly Span[]=[]):number[]{
  if(!record(f.m)||!exact(f.O,["selection","extent","polarity","guard","context"]))throw invalid();
  // Operators must quote their actual words, never a bare whole-claim range.
  for(const value of Object.values(f.O))if(value!==null)sourceOrderedQuote(value);
  const m={...f.m};
  const term=(value:unknown)=>{if(!Array.isArray(value))throw invalid();return value.map(sourceOrderedQuote);};
  for(const key of ["u","i","j"])if(Object.hasOwn(m,key)&&m[key]!==null)m[key]=term(m[key]);
  for(const key of ["G","M","V","B","J"])if(Object.hasOwn(m,key)){
    if(!Array.isArray(m[key]))throw invalid();m[key]=m[key].map(term);
  }
  if(Object.hasOwn(m,"a"))m.a=sourceOrderedQuote(m.a);
  const O=Object.fromEntries(Object.entries(f.O).map(([key,value])=>[key,value===null?null:sourceOrderedQuote(value)]));
  const proof=(value:unknown)=>value===null||exact(value,["first","last"])?value:sourceOrderedQuote(value);
  let F=f.F;
  if(record(F)){
    if(!exact(F,["E","X","T","C","D"])||!Array.isArray(F.C)||!Array.isArray(F.D))throw invalid();
    F={E:proof(F.E),X:proof(F.X),T:proof(F.T),C:F.C.map(proof),D:F.D.map(proof)};
  }
  return sourceDeclaredEvidence(c,{...f,m,O,F},fixed);
}
/** Rows are original reading units, not inferred meanings or coverage credit. */
export function sourceOrderedFactRows(c:SourceReadingClaim,value:unknown):unknown[]{
  if(!Array.isArray(value)||value.length!==c.clauses.length||value.some(row=>!Array.isArray(row)))throw invalid();
  const all=c.clauses.map((_,id)=>id);
  return value.flatMap((row,id)=>row.map((f:unknown)=>{
    if(!record(f)||!record(f.m))throw invalid();
    const quotes:unknown[]=[];
    for(const key of ["u","i","j"])if(f.m[key]!==null&&Object.hasOwn(f.m,key)){
      if(!Array.isArray(f.m[key]))throw invalid();quotes.push(...f.m[key]);
    }
    for(const key of ["G","M","V","B","J"])if(Object.hasOwn(f.m,key)){
      if(!Array.isArray(f.m[key])||f.m[key].some((term:unknown)=>!Array.isArray(term)))throw invalid();
      quotes.push(...f.m[key].flat());
    }
    if(Object.hasOwn(f.m,"a"))quotes.push(f.m.a);
    const own=c.clauses[id];
    if(!quotes.some(q=>{const span=resolveSourceOrderedQuote(c,q,all);return span[0]<own[1]&&span[1]>own[0];}))throw invalid();
    return f;
  }));
}
