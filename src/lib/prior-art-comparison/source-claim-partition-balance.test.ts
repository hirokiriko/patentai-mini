import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {propositionSourceInput,decodeSourcePropositions} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";
import {fictionalQuotationClaim,fictionalScopesFor} from "./source-claim-fixtures.test-support";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";
import {sourceReadingClaim} from "./source-clause-coverage";
import {projectClaimScopeLanes} from "./source-claim-scope-projection";
import {claimLiteralDictionary,mapClaimLiteralFact} from "./source-claim-literal-refs";

function clauses(){return [
 ...Array.from({length:9},(_,i)=>`青弁${i+1}を開く、`),"白管と、",
 "前記分岐器から出た気体を、","前記混合器を経ること無く前記蓄積器に流すための第２の開閉弁と、",
 "制御器を備え、","該制御器により、","前記第１の開閉弁を閉じ、","前記第２の開閉弁を開くことで、",
 "前記送出器から吐出された気体を前記混合器に流し、","その気体を白弁で減圧した後、","青器にて吸熱させ、",
 "前記分岐器から前記蓄積器に流し、","前記送出器に吸い込ませる第１の運転モードと、",
 ...Array.from({length:9},(_,i)=>`赤弁${i+1}を閉じる、`),"第２の運転モードを切り換えて実行する検査装置において、信号を保持する。",
 ];}
function fixture(edit?:(parts:string[])=>void){
 const parts=clauses();edit?.(parts);const text=parts.join(""),f=fictionalInputs();
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
 const plan=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection));
 const tasks=plan.tasks.filter(t=>t.sourceIndex===0),prompts=tasks.map(t=>JSON.parse(t.prompt));
 return{text,parts,plan,tasks,prompts,reading:sourceReadingClaim(1,text)};
}
const ids=(f:ReturnType<typeof fixture>)=>f.prompts.map(p=>p.target.partition.clauseIds as number[]);

it("keeps three tasks while moving the unique possession/control boundary before the first loop",()=>{
 const f=fixture();expect(f.tasks).toHaveLength(3);
 expect(ids(f)).toEqual([Array.from({length:13},(_,i)=>i),Array.from({length:9},(_,i)=>13+i),Array.from({length:10},(_,i)=>22+i)]);
 const all=f.prompts.flatMap(p=>p.target.partition.clauseIds);expect(all).toEqual(f.reading.clauses.map((_,i)=>i));expect(new Set(all).size).toBe(all.length);
 for(const p of f.prompts)expect(p.sourceContext).toEqual(f.prompts[0].sourceContext);
 const obligations=f.prompts.flatMap(p=>p.target.obligations);expect(new Set(obligations.map(o=>o.key)).size).toBe(obligations.length);
 for(const p of f.prompts)for(const o of p.target.obligations)expect(p.target.partition.clauseIds).toContain(o.clause);
 const loops=f.prompts.flatMap(p=>p.target.partition.loopIds);expect(loops.length).toBeGreaterThan(0);expect(new Set(loops).size).toBe(loops.length);
 expect(f.prompts[0].target.partition.loopIds).toEqual([]);expect(f.prompts[1].target.partition.loopIds.length).toBeGreaterThan(0);
});

it.each(["different_actor","multiple","too_far","no_loop","negated"])("keeps original thirds for an unsafe or ambiguous boundary: %s",kind=>{
 const f=fixture(parts=>{
  if(kind==="different_actor")parts[13]="該別制御器により、";
  if(kind==="multiple"){parts[14]="補助器を備え、";parts[15]="該補助器により、";}
  if(kind==="too_far"){parts[12]="青弁を開く、";parts[13]="青弁を開く、";parts[14]="制御器を備え、";parts[15]="該制御器により、";}
  if(kind==="no_loop")parts[20]="前記貯槽へ流す第１の運転モードと、";
  if(kind==="negated")parts[12]="制御器を備えず、";
 });
 expect(ids(f)).toEqual([Array.from({length:11},(_,i)=>i),Array.from({length:11},(_,i)=>11+i),Array.from({length:10},(_,i)=>22+i)]);
});

it("retains cross-boundary possessor, negative route and after-qualified controller/heat citations without filling meaning",()=>{
 const f=fixture(),groups=ids(f),make=(part:number)=>{const c1:Record<string,unknown>={possessions:[],sets:[],...Object.fromEntries(groups[part].map(id=>[`f${id}`,[]])),T:[]};return{d:"fictional",scopes:[] as unknown[],c1};};
 const first=make(0);first.c1.possessions=[{R:12,s:null,m:{k:"relation",P:"has",u:["30-30:検査装置"],x:"capability",p:"positive",a:"12-12:備え",J:[["9-9:白管"],["11-11:第２の開閉弁"],["12-12:制御器"]]},O:[null,null,null,null],F:null}];
 first.c1.f11=[{s:null,m:{k:"relation",P:"executes",u:["11-11:第２の開閉弁"],x:"capability",p:"positive",a:"11-11:流す",J:[["10-11:前記分岐器から出た気体を、前記混合器を経ること無く前記蓄積器に流す"]]},O:[null,null,null,null],F:null}];
 const second=make(1);second.scopes=[{id:"s0",g:"when",G:[["20-20:第１の運転モード"],["17-17:その気体を白弁で減圧した後"]],proof:"17-20:その気体を白弁で減圧した後、青器にて吸熱させ、前記分岐器から前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モード"}];
 second.c1.f18=[{s:"s0",m:{k:"relation",P:"absorbs_heat",u:["20-20:第１の運転モード"],x:"operation",p:"positive",J:[["18-18:青器"]],a:"18-18:吸熱させ"},O:[null,null,null,null],F:null},{s:"s0",m:{k:"relation",P:"executes",u:["13-13:該制御器"],x:"operation",p:"positive",J:[["18-18:青器にて吸熱させ"]],a:"18-18:吸熱させ"},O:[null,null,null,null],F:null}];
 const before=JSON.stringify([first,second]);
 const a=projectClaimScopeLanes(first,1,f.reading,groups[0]),b=projectClaimScopeLanes(second,1,f.reading,groups[1]);
 for(const row of [...a.facts,...b.facts])expect(()=>mapClaimLiteralFact(row,claimLiteralDictionary(f.reading))).not.toThrow();
 expect(a.facts.find(row=>(row.m as {P:string}).P==="has")?.m).toMatchObject({u:["30-30:検査装置"]});
 for(const row of b.facts)expect(row.m).toMatchObject({g:"when",G:[["20-20:第１の運転モード"],["17-17:その気体を白弁で減圧した後"]]});
 expect(JSON.stringify([first,second])).toBe(before);
 const foreign=structuredClone(first);((foreign.c1.possessions as {R:number}[])[0]).R=13;
 expect(()=>projectClaimScopeLanes(foreign,1,f.reading,groups[0])).toThrow();
});

it("assembles a complete balanced fictional answer identically to the strict whole decoder and rejects lost or duplicate evidence",async()=>{
 const body=clauses().join(""),f=fictionalInputs();
 f.inputs.draft=parseComparisonSource(`【請求項1】${body}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${body}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks),reading=sourceReadingClaim(1,body),input=propositionSourceInput(chunks);
 const Q:string[]=[],facts:Record<string,unknown>[]=[],quotes=new Map<string,string>(),q=(id:number,text:string,last=id)=>{const location=`${id}-${last}:${text}`,prior=quotes.get(location);if(prior)return prior;const key=`q${Q.length}`;Q.push(`${key}|${location}`);quotes.set(location,key);return key;};
 const controller=q(13,"該制御器"),mode=q(20,"第１の運転モード"),apparatus=q(30,"検査装置"),mode2=q(30,"第２の運転モード"),after=q(17,"その気体を白弁で減圧した後");
 // Hand-authored fictional meanings must retain causal conditions too. This
 // fixture is not an adapter for modifying or adopting any provider response.
 const cause=[[q(14,"前記第１の開閉弁を閉じ")],[q(15,"前記第２の開閉弁を開くことで")]],modeGuard=[[mode],...cause];
 const guard=q(14,clauses().slice(14,21).join("").replace(/と、$/u,""),20);
 const relation=(R:number,u:string|null,P:string,J:string[][],a:string,G:string[][]=[],proof:string|null=null,x="operation")=>({R,m:{u:u===null?null:[u],x,g:G.length?"when":"unconditional",G,p:"positive",k:"relation",P,J,a},O:[null,null,null,proof,null],F:null});
 for(let i=0;i<9;i++)facts.push(relation(i,null,"opens",[[q(i,`青弁${i+1}`)]],q(i,"開く")));
 facts.push(relation(11,q(11,"第２の開閉弁"),"executes",[[q(10,"前記分岐器から出た気体を、前記混合器を経ること無く前記蓄積器に流す",11)]],q(11,"流す"),[],null,"capability"));
 facts.push(relation(12,apparatus,"has",[[q(9,"白管")],[q(11,"第２の開閉弁")],[q(12,"制御器")]],q(12,"備え"),[],null,"capability"));
 facts.push(relation(14,controller,"closes",[[q(14,"前記第１の開閉弁")]],q(14,"閉じ"),[[mode]],mode));
 facts.push(relation(15,controller,"opens",[[q(15,"前記第２の開閉弁")]],q(15,"開く"),[[mode]],mode));
 for(const[i,action]of [[16,"流し"],[17,"減圧した"],[19,"流し"],[20,"吸い込ませる"]]as const){
  const phrase=clauses()[i].replace(/[、，]$/u,"").replace(/後$/u,"").replace(/第１の運転モードと$/u,"");
  facts.push(relation(i,controller,"executes",[[q(i,phrase)]],q(i,action),i>17?[...modeGuard,[after]]:modeGuard,guard));
 }
 facts.push(relation(18,mode,"absorbs_heat",[[q(18,"青器")]],q(18,"吸熱させ"),[...modeGuard,[after]],guard));
 facts.push(relation(18,controller,"executes",[[q(18,"青器にて吸熱させ")]],q(18,"吸熱させ"),[...modeGuard,[after]],guard));
 facts.push({R:19,m:{u:[mode],x:"operation",g:"when",G:[...modeGuard,[after]],p:"positive",k:"path",i:[q(19,"前記分岐器")],j:[q(20,"前記送出器")],V:[[q(19,"前記蓄積器")]],B:[],e:"whole",r:"route"},O:[null,null,null,guard,null],F:null});
 for(let i=21;i<30;i++)facts.push(relation(i,controller,"closes",[[q(i,`赤弁${i-20}`)]],q(i,"閉じる"),[[mode2]],mode2));
 facts.push(relation(30,apparatus,"executes",[[mode],[q(30,"第２の運転モードを切り換えて実行する")]],q(30,"切り換えて実行する"),[],null,"capability"));
 facts.push(relation(31,apparatus,"executes",[[q(31,"信号を保持する")]],q(31,"保持する"),[],null,"capability"));
 facts.sort((a,b)=>Number(a.R)-Number(b.R));
 const frame=input.sources[0].recognizedLoopRoutes[0];expect(frame).toBeDefined();
 const loop={n:1,b:{a:frame.basisParts[0],z:frame.basisParts[1]},R:20,m:{u:[mode],x:"operation",g:"when",G:modeGuard,p:"positive",k:"path",i:[q(16,"前記送出器")],j:[q(20,"前記送出器")],V:[[q(16,"前記混合器")],[q(17,"白弁")],[q(18,"青器")],[q(19,"前記分岐器")],[q(19,"前記蓄積器")]],B:[],e:"whole",r:"route"},O:[null,null,null,guard,null],F:0};
 const legacy={Q,facts};let projectedLoop:unknown;
 const whole=fictionalQuotationClaim(reading,legacy,project=>{projectedLoop=project(loop);});
 const answers=plan.tasks.map(task=>{
  const p=JSON.parse(task.prompt),ids=p.target.partition.clauseIds as number[];
  const owned=(key:string)=>(whole[key]as {R:number}[]).filter(row=>ids.includes(row.R));
  const c1:Record<string,unknown>={possessions:owned("possessions"),sets:owned("sets"),...Object.fromEntries(ids.map(id=>[`f${id}`,structuredClone(whole[`f${id}`])])),T:p.target.obligations.map((o:{key:string})=>whole.T[Number(o.key.slice(1))])};
  const ownLoops=p.target.partition.loopIds.map((id:number)=>[`loop${id}`,structuredClone(projectedLoop)]),used=new Set([...Object.values(c1).flatMap(v=>Array.isArray(v)?v.filter(row=>row&&typeof row==="object").map(row=>row.s):[]),...(p.target.partition.loopIds.length?[(projectedLoop as {s:string|null}).s]:[])]);
  return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(whole).filter(s=>used.has((s as {id:string}).id)),...Object.fromEntries(ownLoops),c1}};
 });
 const before=JSON.stringify(answers),expected=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!({v:22,s:input.sources.map(s=>({d:s.sourceDigest,c1:legacy,loop0:loop}))});
 expect(expected.success).toBe(true);if(!expected.success)throw expected.error;
 for(const[i,task]of plan.tasks.entries())expect((await task.schema.validate!(answers[i].value)).success).toBe(true);
 const assembled=await assembleSourceClaims(plan,answers);expect(decodeSourcePropositions(chunks,assembled)).toEqual(decodeSourcePropositions(chunks,expected.value));expect(JSON.stringify(answers)).toBe(before);
 const missingCause=structuredClone(answers);
 for(const answer of missingCause)for(const s of answer.value.scopes){const scope=s as {G:string[][]};scope.G=scope.G.filter(term=>!term.some(quote=>/^(?:14|15)-(?:14|15):/u.test(quote)));}
 const missingBefore=JSON.stringify(missingCause);
 expect((await plan.tasks[1].schema.validate!(missingCause[1].value)).success).toBe(false);
 await expect(assembleSourceClaims(plan,missingCause)).rejects.toThrow();
 expect(JSON.stringify(missingCause)).toBe(missingBefore);
 const lost=structuredClone(answers);lost[0].value.c1.possessions=[];await expect(assembleSourceClaims(plan,lost)).rejects.toThrow();
 const duplicate=structuredClone(answers);duplicate[1].value.c1.possessions=structuredClone(answers[0].value.c1.possessions);expect((await plan.tasks[1].schema.validate!(duplicate[1].value)).success).toBe(false);await expect(assembleSourceClaims(plan,duplicate)).rejects.toThrow();
 await expect(assembleSourceClaims(plan,answers.slice(1))).rejects.toThrow();
});
