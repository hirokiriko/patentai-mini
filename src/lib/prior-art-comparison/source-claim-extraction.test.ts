import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";
import {fictionalQuotationClaim} from "./source-claim-fixtures.test-support";
import {decodeClaimQuotationQuotes} from "./source-claim-quotations";
import {resolveSourceOrderedQuote} from "./source-reading-tasks";
import {sourceReadingClaim} from "./source-clause-coverage";

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
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:25,sourceDigest:task.sourceDigest,claimNo:task.claimNo,answer:{d:task.sourceDigest,c1:fictionalQuotationClaim(sourceReadingClaim(1,text.replace("【請求項1】","")),structuredClone(wire.s[task.sourceIndex].c1))}}}));
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
it("uses one consistent readable quote contract while retaining literal obligation bindings",()=>{
 const f=setup();
 for(const [i,task]of f.plan.tasks.entries()){
  const request=JSON.parse(task.prompt);
  expect(request.citationClauses.version).toBe(11);
  expect(request.target).not.toHaveProperty("grid");
  expect(request.target.quoteSource).toBe("制御器は、非通電状態の場合、赤弁を閉じる。");
  expect(request.target.obligations).toEqual([{key:"t0",clause:2,literal:"閉じる"}]);
  expect(task.system).not.toContain("startRow,startColumn,endRow,endColumn");
  for(const quote of f.answers[i].value.answer.c1.Q)expect(Object.keys(quote).sort()).toEqual(["after","before","id","quote"]);
  expect(f.answers[i].value.answer.c1).toHaveProperty("t0",0);
 }
});
it.each(["old_coordinate","missing_context","invented_context","unused_quote"])("rejects obsolete or inconsistent quote declarations without repair: %s",async mode=>{
 const f=setup(),raw=f.answers[0].value,claim=raw.answer.c1;
 if(mode==="old_coordinate")Object.assign(claim,{Q:[{id:"q91",K:[0,0,0,2]}]});
 if(mode==="missing_context")delete(claim.Q[0]as Partial<typeof claim.Q[number]>).before;
 if(mode==="invented_context")claim.Q[0].before="原文に無い架空の前文";
 if(mode==="unused_quote")claim.Q.push({id:"q9999",quote:"御器",before:"",after:""});
 const before=JSON.stringify(raw);
 expect((await f.plan.tasks[0].schema.validate!(raw)).success).toBe(false);
 expect(JSON.stringify(raw)).toBe(before);
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
 if(mode==="invalid_quote")first.value.answer.c1.Q[2].quote="原文に無い架空引用";
 if(mode==="old_version")first.value.v=24;
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

it("states exact ID grammar and exact-context declarations in v25 without changing v22",()=>{
 const f=setup(),before=structuredClone(sourceIdentifiedPropositionModelSchemaFor(f.chunks).jsonSchema);
 const plan=sourceClaimExtractionPlan(f.chunks),schema=plan.tasks[0].schema.jsonSchema as {definitions:Record<string,{description?:string;properties?:Record<string,{description?:string}>;anyOf?:{type?:string;description?:string;properties?:Record<string,{description?:string}>}[]}>};
 const descriptions=[schema.definitions.PriorArtSourceCellQuote.description,schema.definitions.PriorArtSourceDictionaryClaim.properties!.Q.description,schema.definitions.PriorArtSourceDictionaryQuote.properties!.id.description];
 for(const text of [plan.tasks[0].system,...descriptions]){expect(text).toContain("q[0-9]{1,4}");expect(text).toContain("q0a");expect(text).toMatch(/forbidden/);}
 const unsupported=["pattern","minLength","maxLength","format"];
 function entries(v:unknown):string[]{if(!v||typeof v!=="object")return [];if(Array.isArray(v))return v.flatMap(entries);return Object.entries(v).flatMap(([k,x])=>[...(unsupported.includes(k)?[k]:[]),...entries(x)]);}
 expect(entries(schema)).toEqual([]);
 expect(sourceIdentifiedPropositionModelSchemaFor(f.chunks).jsonSchema).toEqual(before);
});

it.each(["missing","negative","out_of_range","quote_instead_of_fact"])("requires every literal action to reference an existing fact: %s",async mode=>{
 const f=setup(),claim=f.answers[0].value.answer.c1 as Record<string,unknown>;
 if(mode==="missing")delete claim.t0;
 if(mode==="negative")claim.t0=-1;
 if(mode==="out_of_range")claim.t0=1;
 if(mode==="quote_instead_of_fact")claim.t0="q8";
 const before=JSON.stringify(f.answers[0].value);
 expect((await f.plan.tasks[0].schema.validate!(f.answers[0].value)).success).toBe(false);
 expect(JSON.stringify(f.answers[0].value)).toBe(before);
});

it("rejects a different occurrence or long evidence quote as the required independent heat action",async()=>{
 const f=fictionalInputs(),text="制御器は、青放熱器にて放熱させ、白吸熱器にて吸熱させる。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const plan=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)),task=plan.tasks[0];
 const fact=(R:number,P:string,J:string,a:string)=>({R,m:{u:["q0"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P,J:[[J]],a},O:[null,null,null,null,null],F:null});
 const claim=fictionalQuotationClaim(sourceReadingClaim(1,text),{
  Q:["q0|0-0:制御器","q1|1-1:青放熱器","q2|1-1:放熱させ","q3|2-2:白吸熱器","q4|2-2:吸熱させる"],
  facts:[fact(1,"releases_heat","q1","q2"),fact(2,"absorbs_heat","q3","q4")],
 });
 const raw={v:25,sourceDigest:task.sourceDigest,claimNo:1,answer:{d:task.sourceDigest,c1:claim}};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);Object.assign(wrong.answer.c1,{t1:0});
 expect((await task.schema.validate!(wrong)).success).toBe(false);
 const absent=structuredClone(raw);absent.answer.c1.facts.pop();Object.assign(absent.answer.c1,{t1:0});
 const before=JSON.stringify(absent);
 expect((await task.schema.validate!(absent)).success).toBe(false);
 expect(JSON.stringify(absent)).toBe(before);
});

it("requires the maintained state and verb together in both action and object",async()=>{
 const f=fictionalInputs(),text="制御器は、青弁の開度を所定の値に維持する。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0];
 const full="青弁の開度を所定の値に維持する";
 const original={Q:["q0|0-0:制御器",`q1|1-1:${full}`],facts:[{R:1,m:{u:["q0"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"maintains",J:[["q1"]],a:"q1"},O:[null,null,null,null,null],F:null}]};
 const reading=sourceReadingClaim(1,text),claim=fictionalQuotationClaim(reading,original);
 const raw={v:25,sourceDigest:task.sourceDigest,claimNo:1,answer:{d:task.sourceDigest,c1:claim}};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const split=structuredClone(original);split.Q.push("q2|1-1:維持する");split.facts[0].m.a="q2";
 const bad={...raw,answer:{...raw.answer,c1:fictionalQuotationClaim(reading,split)}};
 const before=JSON.stringify(bad);
 expect((await task.schema.validate!(bad)).success).toBe(false);
 expect(JSON.stringify(bad)).toBe(before);
});


it("rejects a prefix from another claim even when that exact prefix occurs in the same source",async()=>{
 const f=fictionalInputs(),first="別の制御器は、非通電状態の場合、赤弁を閉じる。",second="制御器は、非通電状態の場合、赤弁を閉じる。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${first}\n【請求項2】${second}`,11,"架空");f.selection.draftClaimNos=[1,2];
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${second}`,d.id,"架空"));
 const plan=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)),task=plan.tasks.find(t=>t.sourceIndex===0&&t.claimNo===2)!;
 const c=fictionalQuotationClaim(sourceReadingClaim(2,second),{Q:["q0|0-0:制御器","q1|1-1:非通電状態の場合","q2|2-2:赤弁","q3|2-2:閉じる"],facts:[{R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q1"]],p:"positive",k:"relation",P:"closes",J:[["q2"]],a:"q3"},O:[null,null,null,"q1",null],F:null}]});
 const request=JSON.parse(task.prompt);
 expect(request.target.quoteSource).toBe(second);
 expect(request.target.quoteSource).not.toContain("別の");
 const raw={v:25,sourceDigest:task.sourceDigest,claimNo:2,answer:{d:task.sourceDigest,c2:c}};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);wrong.answer.c2.Q.find(q=>q.id==="q0")!.before="別の";
 const before=JSON.stringify(wrong);
 expect((await task.schema.validate!(wrong)).success).toBe(false);
 expect(JSON.stringify(wrong)).toBe(before);
});

it("keeps the operative actor occurrence distinct from the same name in a condition",async()=>{
 const f=fictionalInputs(),text="制御器は、制御器が非通電状態の場合、赤弁を閉じる。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0];
 const c=fictionalQuotationClaim(sourceReadingClaim(1,text),{Q:["q0|0-0:制御器","q1|1-1:制御器が非通電状態の場合","q2|2-2:赤弁","q3|2-2:閉じる"],facts:[{R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q1"]],p:"positive",k:"relation",P:"closes",J:[["q2"]],a:"q3"},O:[null,null,null,"q1",null],F:null}]});
 const raw={v:25,sourceDigest:task.sourceDigest,claimNo:1,answer:{d:task.sourceDigest,c1:c}};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);Object.assign(wrong.answer.c1.Q.find(q=>q.id==="q0")!,{before:"制御器は、",after:"が非通電状態の場合"});
 expect((await task.schema.validate!(wrong)).success).toBe(false);
});

it("binds route endpoints to operative route occurrences rather than same-name component definitions",()=>{
 const text="入口器と出口器を備え、入口器から気体を出口器へ流す。",c=sourceReadingClaim(1,text);
 const raw=[{id:"q0",quote:"入口器",before:"備え、",after:"から気体を"},{id:"q1",quote:"出口器",before:"から気体を",after:"へ流す"}];
 const before=JSON.stringify(raw),decoded=decodeClaimQuotationQuotes(c,raw) as {id:string;first:number;last:number;quote:string;before:string;after:string}[];
 const spans=decoded.map(({id,...q})=>({id,span:resolveSourceOrderedQuote(c,q,Array.from({length:q.last-q.first+1},(_,i)=>q.first+i))}));
 expect(spans).toEqual([{id:"q0",span:[text.lastIndexOf("入口器"),text.lastIndexOf("入口器")+3]},{id:"q1",span:[text.lastIndexOf("出口器"),text.lastIndexOf("出口器")+3]}]);
 expect(spans[0].span[0]).not.toBe(text.indexOf("入口器"));
 expect(spans[1].span[0]).not.toBe(text.indexOf("出口器"));
 expect(()=>decodeClaimQuotationQuotes(c,[{...raw[0],before:"",after:""}])).toThrow();
 expect(JSON.stringify(raw)).toBe(before);
});
