import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";
import {sourceReadingClaim} from "./source-clause-coverage";
import {sourceLocalStateGuard} from "./source-semantic-check";

function planFor(text:string){
  const f=fictionalInputs(),source=`【請求項1】${text}`;
  f.inputs.draft=parseComparisonSource(source,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(source,d.id,"架空"));
  return sourceClaimExtractionPlan(makePlan(f.inputs,f.selection));
}
const fact=(s:string,P:string,object:string,action:string)=>({s,m:{u:null,x:"capability",p:"positive",k:"relation",P,J:[[object]],a:action},O:[null,null,null,null],F:null});
const scope=(id:string,reference:string)=>({id,g:"when",G:[[reference]],proof:reference});
function repeated(marker="状態で"){
  const text=`青板は低温${marker}閉じ、高温${marker}開き、赤板は低温${marker}開き、高温${marker}閉じる。`;
  const plan=planFor(text),task=plan.tasks[0];
  const scopes=[0,1,2,3].map(i=>scope(`s${i}`,`${i}-${i}:${i%2?"高温":"低温"}${marker}`));
  const value={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes,c1:{possessions:[],sets:[],
    f0:[fact("s0","closes","0-0:青板","0-0:閉じ")],
    f1:[fact("s1","opens","0-0:青板","1-1:開き")],
    f2:[fact("s2","opens","2-2:赤板","2-2:開き")],
    f3:[fact("s3","closes","2-2:赤板","3-3:閉じる")],T:["f0:0","f1:0","f2:0","f3:0"]}};
  return {plan,task,value};
}

it.each(["状態で","状態では","状態において"])("preserves each repeated local %s occurrence through the actual claim decoder",async marker=>{
  const {plan,task,value}=repeated(marker),before=JSON.stringify(value);
  expect((await task.schema.validate!(value)).success).toBe(true);
  const answers=plan.tasks.map(t=>({taskId:t.id,value:{...structuredClone(value),sourceDigest:t.sourceDigest,d:t.sourceDigest}}));
  await expect(assembleSourceClaims(plan,answers)).resolves.toBeTruthy();
  expect(JSON.stringify(value)).toBe(before);
  expect(task.system).toContain("respective original coordinates");
});

it.each(["later_to_earlier","earlier_to_later","cold_G_only","cold_proof_only","hot_G_only","hot_proof_only","missing_G"])("rejects a different predicate's identical state citation without repairing it: %s",async mutation=>{
  const {task,value}=repeated();
  if(mutation==="later_to_earlier"){
    value.c1.f2[0].s="s0";value.c1.f3[0].s="s1";value.scopes.splice(2);
  }else if(mutation==="earlier_to_later"){
    value.c1.f0[0].s="s2";value.c1.f1[0].s="s3";value.scopes.splice(0,2);
  }else if(mutation==="missing_G")value.scopes[2].G=[];
  else{
    const i=mutation.startsWith("cold")?2:3;
    if(mutation.endsWith("G_only"))value.scopes[i].G=structuredClone(value.scopes[i-2].G);
    else value.scopes[i].proof=value.scopes[i-2].proof;
  }
  const before=JSON.stringify(value);
  expect((await task.schema.validate!(value)).success).toBe(false);
  expect(JSON.stringify(value)).toBe(before);
});

it.each(["2-2:低温状態で開き","2-2:赤板は低温状態で開き"])("checks actual predicate positions inside broad action quotes: %s",async action=>{
  const {task,value}=repeated();value.c1.f2[0].m.a=action;
  expect((await task.schema.validate!(value)).success).toBe(true);
  value.c1.f2[0].s="s0";value.scopes.splice(2,1);
  const before=JSON.stringify(value);
  expect((await task.schema.validate!(value)).success).toBe(false);
  expect(JSON.stringify(value)).toBe(before);
});

it.each([
  ["低温状態で、青板を閉じ、赤板を開く。","0-0:低温状態で",1,2],
  ["停止した後、青板を閉じ、赤板を開く。","0-0:停止した後",1,2],
  ["温度が下がった後、又は、圧力が下がった後に青板を閉じ、赤板を開く。","0-2:温度が下がった後、又は、圧力が下がった後",2,3],
] as const)("preserves one genuinely shared condition without requiring local copies: %s",async(text,guard,first,second)=>{
  const task=planFor(text).tasks[0],clauses=sourceReadingClaim(1,text).clauses;
  const c1={possessions:[],sets:[],...Object.fromEntries(clauses.map((_,i)=>[`f${i}`,[]])),T:[`f${first}:0`,`f${second}:0`]};
  Object.assign(c1,{[`f${first}`]:[fact("s0","closes",`${first}-${first}:青板`,`${first}-${first}:閉じ`)],
    [`f${second}`]:[fact("s0","opens",`${second}-${second}:赤板`,`${second}-${second}:開く`)]});
  const value={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:[scope("s0",guard)],c1};
  const before=JSON.stringify(value);
  expect((await task.schema.validate!(value)).success).toBe(true);
  expect(JSON.stringify(value)).toBe(before);
  expect(task.system).not.toContain("respective original coordinates");
});

it.each(["「青板は低温状態で閉じる」という例。","青板は閉じた状態で開く。","青板は低温状態でも開く。"])("does not infer a local state guard from unrecognized syntax: %s",text=>{
  const c=sourceReadingClaim(1,text),word=text.includes("開く")?"開く":"閉じる",start=text.indexOf(word);
  expect(sourceLocalStateGuard(c,[start,start+word.length])).toBeNull();
});
