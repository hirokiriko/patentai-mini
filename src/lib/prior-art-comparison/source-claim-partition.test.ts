import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {propositionSourceInput,decodeSourcePropositions} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";
import {fictionalQuotationClaim,fictionalScopesFor} from "./source-claim-fixtures.test-support";
import {sourceReadingClaim} from "./source-clause-coverage";

// Handwritten fictional facts only; never an adapter for provider answers.
function fixture(text:string,legacy:{Q:string[];facts:Record<string,unknown>[]}){
 const f=fictionalInputs();f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks),whole=fictionalQuotationClaim(sourceReadingClaim(1,text),legacy);
 const answers=plan.tasks.map(task=>{
  const p=JSON.parse(task.prompt),ids=p.target.partition.clauseIds as number[];
  const owned=(key:string)=>(whole[key] as {R:number}[]).filter(r=>ids.includes(r.R));
  const c1:Record<string,unknown>={possessions:owned("possessions"),sets:owned("sets"),...Object.fromEntries(ids.map(id=>[`f${id}`,structuredClone(whole[`f${id}`])])),T:p.target.obligations.map((o:{key:string})=>whole.T[Number(o.key.slice(1))])};
  const used=new Set(Object.values(c1).flatMap(v=>Array.isArray(v)?v.filter(r=>r&&typeof r==="object").map(r=>r.s):[]));
  const scopes=fictionalScopesFor(whole).filter(s=>used.has((s as {id:string}).id));
  return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes,c1}};
 });
 return{chunks,plan,answers,legacy};
}
async function equivalent(f:ReturnType<typeof fixture>){
 expect(f.plan.tasks).toHaveLength(6);const before=JSON.stringify(f.answers);
 for(const[i,task]of f.plan.tasks.entries())expect((await task.schema.validate!(f.answers[i].value)).success).toBe(true);
 const expected={v:22,s:propositionSourceInput(f.chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(f.legacy)}))};
 const checked=await sourceIdentifiedPropositionModelSchemaFor(f.chunks).validate!(expected);expect(checked.success).toBe(true);if(!checked.success)throw checked.error;
 const union=await assembleSourceClaims(f.plan,f.answers);expect(union).toEqual(checked.value);
 expect(decodeSourcePropositions(f.chunks,union)).toEqual(decodeSourcePropositions(f.chunks,checked.value));expect(JSON.stringify(f.answers)).toBe(before);
}
it.each(["route","possession"])("retains cross-part %s and negation, with full-union omission rejection",async kind=>{
 const clauses=["制御器により、",...Array.from({length:29},(_,i)=>`青弁${i+1}を開く、`),"冬モード。"];
 const special=kind==="route"?[15,16]:[14,15,16];
 if(kind==="route"){clauses[15]="白管から、";clauses[16]="黒管へ流し、";}
 else{clauses[14]="白管と、";clauses[15]="黒管と、";clauses[16]="青管を備え、";}
 clauses[20]="青弁20を開かない、";
 const Q=["q0|0-0:制御器","q1|30-30:冬モード"],facts:Record<string,unknown>[]=[];
 const q=(at:number,text:string)=>{const id=`q${Q.length}`;Q.push(`${id}|${at}-${at}:${text}`);return id;};
 for(let i=1;i<30;i++){
  if(special.includes(i)){if(i!==16)continue;
   if(kind==="route")facts.push({R:16,m:{u:["q1"],x:"operation",g:"unconditional",G:[],p:"positive",k:"path",i:[q(15,"白管")],j:[q(16,"黒管")],V:[],B:[],e:"whole",r:"route"},O:[null,null,null,null,null],F:null});
   else facts.push({R:16,m:{u:null,x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"has",J:[[q(14,"白管")],[q(15,"黒管")],[q(16,"青管")]],a:q(16,"備え")},O:[null,null,null,null,null],F:null});
   continue;
  }
  const obj=q(i,`青弁${i}`),action=q(i,i===20?"開かない":"開く");
  facts.push({R:i,m:{u:["q0"],x:"operation",g:"when",G:[["q1"]],p:i===20?"negative":"positive",k:"relation",P:"opens",J:[[obj]],a:action},O:[null,null,i===20?action:null,"q1",null],F:null});
 }
 const f=fixture(clauses.join(""),{Q,facts});await equivalent(f);
 const lost=structuredClone(f.answers);if(kind==="route")lost[1].value.c1.f16=[];else lost[1].value.c1.possessions=[];
 await expect(assembleSourceClaims(f.plan,lost)).rejects.toThrow();
 const bad=structuredClone(f.answers);const neg=bad[1].value.c1.f20 as {m:{p:string}}[];neg[0].m.p="positive";
 await expect(assembleSourceClaims(f.plan,bad)).rejects.toThrow();
 const duplicate=structuredClone(f.answers);duplicate[0].value.c1.possessions=structuredClone(f.answers[1].value.c1.possessions);
 if(kind==="possession")expect((await f.plan.tasks[0].schema.validate!(duplicate[0].value)).success).toBe(false);
});
it("permits an OR condition owned only by the second part while the union still requires every alternative",async()=>{
 const text="制御器により、"+Array.from({length:26},(_,i)=>`青弁${i+1}を開く、`).join("")+"停止後、又は、起動時、赤弁を開く。";
 const Q=["q0|0-0:制御器"],facts:Record<string,unknown>[]=[];
 const q=(at:number,text:string,last=at)=>{const id=`q${Q.length}`;Q.push(`${id}|${at}-${last}:${text}`);return id;};
 for(let i=1;i<=26;i++)facts.push({R:i,m:{u:["q0"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"opens",J:[[q(i,`青弁${i}`)]],a:q(i,"開く")},O:[null,null,null,null,null],F:null});
 const guard=q(27,"停止後、又は、起動時",29);
 facts.push({R:30,m:{u:["q0"],x:"operation",g:"when",G:[[guard]],p:"positive",k:"relation",P:"opens",J:[[q(30,"赤弁")]],a:q(30,"開く")},O:[null,null,null,guard,null],F:null});
 const f=fixture(text,{Q,facts});await equivalent(f);
 const bad=structuredClone(f.answers);const scope=bad[1].value.scopes[0] as {G:string[][]};scope.G=[["27-27:停止後"],["29-29:起動時"]];
 await expect(assembleSourceClaims(f.plan,bad)).rejects.toThrow();
 const missing=structuredClone(f.answers);const row=missing[1].value.c1.f30 as {s:string|null}[];row[0].s=null;missing[1].value.scopes=[];
 await expect(assembleSourceClaims(f.plan,missing)).rejects.toThrow();
});
it("assigns complete recognized loops once to the final part without changing their original IDs or references",()=>{
 const f=fictionalInputs(),body="制御器により、"+Array.from({length:24},(_,i)=>`青弁${i+1}を開く、`).join("")+"前記分岐器から出た気体を、前記混合器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記混合器に流し、前記分岐器から前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${body}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
 const chunks=makePlan(f.inputs,f.selection),source=propositionSourceInput(chunks).sources[0],parts=sourceClaimExtractionPlan(chunks).tasks.filter(t=>t.sourceIndex===0);
 expect(source.recognizedLoopRoutes.length).toBeGreaterThan(0);expect(parts).toHaveLength(2);
 const prompts=parts.map(t=>JSON.parse(t.prompt));expect(prompts[0].sourceContext).toEqual(prompts[1].sourceContext);
 expect(prompts[0].target.partition.loopIds).toEqual([]);
 expect(prompts[1].target.partition.loopIds).toEqual(source.recognizedLoopRoutes.map((_,i)=>i));
 for(const[i]of source.recognizedLoopRoutes.entries()){
  const first=parts[0].schema.jsonSchema,last=parts[1].schema.jsonSchema;
  expect(first.properties).not.toHaveProperty(`loop${i}`);expect(first.additionalProperties).toBe(false);
  expect(last.required).toContain(`loop${i}`);expect(last.additionalProperties).toBe(false);
 }
});
