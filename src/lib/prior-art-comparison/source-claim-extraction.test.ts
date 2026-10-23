import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";

// Only hand-authored fictional output is split here. Never use this adapter to
// repair, reassign or accept a provider response.
function setup(actor="制御器"){
 const f=fictionalInputs(),text=`【請求項1】${actor}は、非通電状態の場合、赤弁を閉じる。`;
 f.inputs.draft=parseComparisonSource(text,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),input=propositionSourceInput(chunks);
 const claim=()=>({Q:[`q91|0-0:${actor}`,"q4|1-1:非通電状態の場合","q73|2-2:赤弁","q8|2-2:閉じる"],facts:[{R:2,m:{u:["q91"],x:"operation",g:"when",G:[["q4"]],p:"positive",k:"relation",P:"closes",J:[["q73"]],a:"q8"},O:[null,null,null,"q4",null],F:null}]});
 const wire={v:22,s:input.sources.map(s=>({d:s.sourceDigest,c1:claim()}))};
 const plan=sourceClaimExtractionPlan(chunks);
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:23,sourceDigest:task.sourceDigest,claimNo:task.claimNo,answer:structuredClone(wire.s[task.sourceIndex])}}));
 return {chunks,input,wire,plan,answers};
}
it("assembles exactly once in original source order and is equivalent to the existing strict decoder",async()=>{
 const f=setup(),before=JSON.stringify(f.answers),r=await sourceIdentifiedPropositionModelSchemaFor(f.chunks).validate!(f.wire);
 expect(r.success).toBe(true);if(!r.success)throw r.error;
 const assembled=await assembleSourceClaims(f.plan,[...f.answers].reverse());
 expect(assembled).toEqual(r.value);
 expect(decodeSourcePropositions(f.chunks,assembled)).toEqual(decodeSourcePropositions(f.chunks,r.value));
 expect(JSON.stringify(f.answers)).toBe(before);
 expect(new Set(f.plan.tasks.map(t=>t.id)).size).toBe(f.plan.tasks.length);
 expect(f.plan.tasks.map(t=>[t.sourceIndex,t.claimNo])).toEqual([[0,1],[1,1],[2,1]]);
});
it.each(["missing","duplicate","foreign_task","wrong_source","wrong_claim","foreign_key","undeclared_quote","invalid_quote","old_version"])("rejects %s without partial successful extraction or input repair",async mode=>{
 const f=setup(),before=JSON.stringify(f.wire),first=f.answers[0];
 if(mode==="missing")f.answers.pop();
 if(mode==="duplicate")f.answers.push(structuredClone(first));
 if(mode==="foreign_task")first.taskId="unplanned-task";
 if(mode==="wrong_source")first.value.sourceDigest=f.answers[1].value.sourceDigest;
 if(mode==="wrong_claim")first.value.claimNo=2;
 if(mode==="foreign_key")Object.assign(first.value.answer,{c2:structuredClone(first.value.answer.c1)});
 if(mode==="undeclared_quote")first.value.answer.c1.facts[0].m.a="q404";
 if(mode==="invalid_quote")first.value.answer.c1.Q[2]="q73|2-2:青弁";
 if(mode==="old_version")first.value.v=22;
 const raw=JSON.stringify(f.answers);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
 expect(JSON.stringify(f.answers)).toBe(raw);expect(JSON.stringify(f.wire)).toBe(before);
});
it("rejects combined wire overflow even when every individual claim reply is below 64000 bytes",async()=>{
 const f=setup();
 // Repeated fully cited facts exercise the aggregate transport boundary;
 // do not introduce a malformed quote merely to increase the byte count.
 for(const a of f.answers){const fact=structuredClone(a.value.answer.c1.facts[0]);fact.m.G=Array.from({length:8},()=>["q4"]);a.value.answer.c1.facts=Array.from({length:96},()=>structuredClone(fact));}
 for(const [i,a] of f.answers.entries())expect((await f.plan.tasks[i].schema.validate!(a.value)).success).toBe(true);
 expect(f.answers.every(a=>Buffer.byteLength(JSON.stringify(a.value),"utf8")<64000)).toBe(true);
 expect(Buffer.byteLength(JSON.stringify({v:22,s:f.answers.map(a=>a.value.answer)}),"utf8")).toBeGreaterThan(64000);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
});
it("keeps complete ancestor text and source-local identity in dependent-claim request context",()=>{
 const f=fictionalInputs(),text="【請求項1】制御器は、非通電状態の場合、赤弁を閉じる。\n【請求項2】請求項1に記載の装置であって、青弁を備える。";
 f.inputs.draft=parseComparisonSource(text,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
 f.selection.draftClaimNos=[2];f.selection.documents=f.selection.documents.map(d=>({...d,claimNos:[2]}));
 const plan=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection));
 expect(plan.tasks.map(t=>t.claimNo)).toEqual([1,2,1,2,1,2]);
 for(const t of plan.tasks.filter(t=>t.claimNo===2)){
  expect(t.prompt).toContain("非通電状態の場合");expect(t.prompt).toContain("赤弁を閉じる");expect(t.prompt).toContain("青弁を備える");
  expect(t.prompt).toContain(t.sourceDigest);
 }
});

it("preserves batch-global loop IDs while limiting each claim answer to its own loop keys",()=>{
 const f=fictionalInputs(),body="前記分岐器から出た気体を、前記混合器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記混合器に流し、前記分岐器から前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${body}\n【請求項2】${body}`,11,"架空基準");f.selection.draftClaimNos=[1,2];
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
 const chunks=makePlan(f.inputs,f.selection),input=propositionSourceInput(chunks),plan=sourceClaimExtractionPlan(chunks);
 expect(input.sources[0].recognizedLoopRoutes.map(r=>r.claimNo)).toEqual([1,2]);
 const first=plan.tasks.find(t=>t.sourceIndex===0&&t.claimNo===1)!,second=plan.tasks.find(t=>t.sourceIndex===0&&t.claimNo===2)!;
 const answerKeys=(task:typeof first)=>{
  const schema=task.schema.jsonSchema as {properties?:Record<string,{properties?:Record<string,unknown>}>};
  return Object.keys(schema.properties?.answer.properties??{});
 };
 expect(answerKeys(first)).toEqual(expect.arrayContaining(["d","c1","loop0"]));
 expect(answerKeys(first)).not.toContain("loop1");
 expect(answerKeys(second)).toEqual(expect.arrayContaining(["d","c2","loop1"]));
 expect(answerKeys(second)).not.toContain("loop0");
});

it.each(["invalid_context","reserved_context","extra_meaning_key","bypass_role_conflict","long_actor"])("rejects claim-local domain failure before any next request: %s",async mode=>{
 const f=setup(mode==="long_actor"?"制"+"御".repeat(80):undefined),claim=f.answers[0].value.answer.c1;
 if(mode==="invalid_context")claim.facts[0].m.x="invalid_context";
 if(mode==="reserved_context")claim.facts[0].m.x="unresolved";
 if(mode==="extra_meaning_key")Object.assign(claim.facts[0].m,{claimNo:1});
 if(mode==="bypass_role_conflict"){
  const path={R:2,m:{u:["q91"],x:"operation",g:"when",G:[["q4"]],p:"positive",k:"path",i:["q73"],j:["q73"],V:[],B:[["q73"]],e:"segment",r:"route"},O:[null,null,null,"q4",null],F:null};
  (claim.facts as unknown[]).push(path);
 }
 const before=JSON.stringify(f.answers[0].value);
 expect((await f.plan.tasks[0].schema.validate!(f.answers[0].value)).success).toBe(false);
 expect(JSON.stringify(f.answers[0].value)).toBe(before);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
});
