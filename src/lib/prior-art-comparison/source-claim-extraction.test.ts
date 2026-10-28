import {assertSourceSemanticReading,sourceFullActionCues} from "./source-semantic-check";
import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceIdentifiedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceClaimExtractionPlan,assembleSourceClaims} from "./source-claim-extraction";
import {fictionalQuotationClaim,fictionalScopesFor} from "./source-claim-fixtures.test-support";
import {decodeClaimQuotationQuotes} from "./source-claim-quotations";
import {resolveSourceOrderedQuote} from "./source-reading-tasks";
import {sourceReadingClaim} from "./source-clause-coverage";
import {SOURCE_CAPACITY} from "./source-capacity";

function groupFact<T extends {R:number}>(value:T){const {R,...fact}=value;void R;return fact;}
function setupFacts(claim:Record<string,unknown>){return claim.f2 as ReturnType<typeof setup>["wire"]["s"][number]["c1"]["facts"];}
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
 const answers=plan.tasks.map(task=>{const c1=fictionalQuotationClaim(sourceReadingClaim(1,text.replace("【請求項1】","")),structuredClone(wire.s[task.sourceIndex].c1));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:task.claimNo,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};});
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
  expect(request.citationClauses.version).toBe(20);
  expect(request.target).not.toHaveProperty("grid");
  expect(request.target).not.toHaveProperty("quoteSource");
  expect(request.sourceContext.source.claims[0].clauses.map(([,text]:[number,string])=>text).join("")).toBe("制御器は、非通電状態の場合、赤弁を閉じる。");
  expect(request.target.obligations).toEqual([{key:"t0",clause:2,predicate:"closes",literal:"閉じる"}]);
  expect(task.system).not.toContain("startRow,startColumn,endRow,endColumn");
  expect(f.answers[i].value.c1).not.toHaveProperty("Q");
  expect(setupFacts(f.answers[i].value.c1)[0].m.a).toBe("2-2:閉じる");
  expect(f.answers[i].value.c1.T).toEqual(["f2:0"]);
 }
});
it.each(["old_coordinate","missing_context","invented_context","unused_quote"])("rejects obsolete or inconsistent quote declarations without repair: %s",async mode=>{
 const f=setup(),raw=f.answers[0].value,claim=raw.c1;
 if(mode==="old_coordinate")Object.assign(claim,{Q:[{id:"q91",K:[0,0,0,2]}]});
 if(mode==="missing_context")setupFacts(claim)[0].m.a="2-2#0:閉じる";
 if(mode==="invented_context")setupFacts(claim)[0].m.a="2-2:前記閉じる";
 if(mode==="unused_quote")Object.assign(claim,{Q:[{id:"q9999",quote:"御器"}]});
 const before=JSON.stringify(raw);
 expect((await f.plan.tasks[0].schema.validate!(raw)).success).toBe(false);
 expect(JSON.stringify(raw)).toBe(before);
});
it.each(["missing","duplicate","foreign_task","wrong_source","wrong_claim","foreign_key","undeclared_quote","invalid_quote","old_version","previous_version"])("rejects %s without partial successful extraction or input repair",async mode=>{
 const f=setup(),before=JSON.stringify(f.wire),first=f.answers[0];
 if(mode==="missing")f.answers.pop();
 if(mode==="duplicate")f.answers.push(structuredClone(first));
 if(mode==="foreign_task")first.taskId="unplanned-task";
 if(mode==="wrong_source")first.value.sourceDigest=f.answers[1].value.sourceDigest;
 if(mode==="wrong_claim")first.value.claimNo=2;
 if(mode==="foreign_key")Object.assign(first.value,{c2:structuredClone(first.value.c1)});
 if(mode==="undeclared_quote")setupFacts(first.value.c1)[0].m.a="q404";
 if(mode==="invalid_quote")setupFacts(first.value.c1)[0].m.a="2-2:原文に無い架空引用";
 if(mode==="previous_version")first.value.v=33;
 if(mode==="old_version")first.value.v=24;
 const raw=JSON.stringify(f.answers);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
 expect(JSON.stringify(f.answers)).toBe(raw);expect(JSON.stringify(f.wire)).toBe(before);
});
it("rejects combined wire overflow even when every individual claim reply is below 64000 bytes",async()=>{
 const f=setup();
 // Repeated fully cited facts exercise the aggregate transport boundary;
 // do not introduce a malformed quote merely to increase the byte count.
 for(const a of f.answers){const fact=structuredClone(setupFacts(a.value.c1)[0]);fact.m.J=Array.from({length:12},()=>["2-2:赤弁"]);a.value.c1.f2=Array.from({length:96},()=>structuredClone(fact));}
 for(const [i,a] of f.answers.entries())expect((await f.plan.tasks[i].schema.validate!(a.value)).success).toBe(true);
 expect(f.answers.every(a=>Buffer.byteLength(JSON.stringify(a.value),"utf8")<64000)).toBe(true);
 expect(Buffer.byteLength(JSON.stringify({v:22,s:f.answers.map(a=>a.value)}),"utf8")).toBeGreaterThan(64000);
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
  return Object.keys(schema.properties??{}).filter(k=>!["v","sourceDigest","claimNo"].includes(k));
 };
 expect(answerKeys(first)).toEqual(["d","scopes","loop0","c1"]);
 expect(answerKeys(first)).not.toContain("loop1");
 expect(answerKeys(second)).toEqual(["d","scopes","loop1","c2"]);
 expect(answerKeys(second)).not.toContain("loop0");
});

it.each(["invalid_context","reserved_context","extra_meaning_key","bypass_role_conflict","long_actor"])("rejects claim-local domain failure before any next request: %s",async mode=>{
 const f=setup(mode==="long_actor"?"制"+"御".repeat(80):undefined),claim=f.answers[0].value.c1;
 if(mode==="invalid_context")setupFacts(claim)[0].m.x="invalid_context";
 if(mode==="reserved_context")setupFacts(claim)[0].m.x="unresolved";
 if(mode==="extra_meaning_key")Object.assign(setupFacts(claim)[0].m,{claimNo:1});
 if(mode==="bypass_role_conflict"){
  const path={R:2,m:{u:["q91"],x:"operation",g:"when",G:[["q4"]],p:"positive",k:"path",i:["q73"],j:["q73"],V:[],B:[["q73"]],e:"segment",r:"route"},O:[null,null,null,"q4",null],F:null};
  (claim.f2 as unknown[]).push(path);
 }
 const before=JSON.stringify(f.answers[0].value);
 expect((await f.plan.tasks[0].schema.validate!(f.answers[0].value)).success).toBe(false);
 expect(JSON.stringify(f.answers[0].value)).toBe(before);
 await expect(assembleSourceClaims(f.plan,f.answers)).rejects.toThrow();
});

it("uses direct exact original references without qID declarations or unsupported schema constraints",()=>{
 const f=setup(),before=structuredClone(sourceIdentifiedPropositionModelSchemaFor(f.chunks).jsonSchema),schema=f.plan.tasks[0].schema.jsonSchema as {definitions:Record<string,{description?:string;properties?:Record<string,unknown>}>};
 expect(schema.definitions.PriorArtSourceCellQuote.description).toContain("first-last:quote");
 expect(schema.definitions.PriorArtSourceDictionaryClaim.properties).not.toHaveProperty("Q");
 expect(f.plan.tasks[0].system).toContain("No output Q dictionary");
 expect(f.plan.tasks[0].system).toContain("proof contains ALL");
 expect(sourceIdentifiedPropositionModelSchemaFor(f.chunks).jsonSchema).toEqual(before);
});

it.each(["missing","negative","out_of_range","quote_instead_of_fact"])("requires every literal action to reference an existing fact: %s",async mode=>{
 const f=setup(),claim=f.answers[0].value.c1 as Record<string,unknown>;
 if(mode==="missing")delete claim.T;
 if(mode==="negative")claim.T=["f2:-1"];
 if(mode==="out_of_range")claim.T=["f2:1"];
 if(mode==="quote_instead_of_fact")claim.T=["q8"];
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
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(claim),c1:claim};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);wrong.c1.T[1]="f1:0";
 expect((await task.schema.validate!(wrong)).success).toBe(false);
 const truncated=structuredClone(raw);(truncated.c1.f1 as {m:{a:string}}[])[0].m.a="1-1:放熱さ";
 expect((await task.schema.validate!(truncated)).success).toBe(false);
 const absent=structuredClone(raw);(absent.c1.f2 as unknown[]).pop();absent.c1.T[1]="f1:0";
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
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(claim),c1:claim};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const split=structuredClone(original);split.Q.push("q2|1-1:維持する");split.facts[0].m.a="q2";
 const bad={...raw,...raw,c1:fictionalQuotationClaim(reading,split)};
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
 expect(request.target).not.toHaveProperty("quoteSource");
 expect(request.sourceContext.source.claims.find((c:{claimNo:number})=>c.claimNo===2).clauses.map(([,text]:[number,string])=>text).join("")).toBe(second);
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:2,d:task.sourceDigest,scopes:fictionalScopesFor(c),c2:c};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);(wrong.c2.f2 as {m:{u:string[]}}[])[0].m.u=["0-0:別の制御器"];
 const before=JSON.stringify(wrong);
 expect((await task.schema.validate!(wrong)).success).toBe(false);
 expect(JSON.stringify(wrong)).toBe(before);
});

it("keeps the operative actor occurrence distinct from the same name in a condition",async()=>{
 const f=fictionalInputs(),text="制御器は、制御器が非通電状態の場合、赤弁を閉じる。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0];
 const c=fictionalQuotationClaim(sourceReadingClaim(1,text),{Q:["q0|0-0:制御器","q1|1-1:制御器が非通電状態の場合","q2|2-2:赤弁","q3|2-2:閉じる"],facts:[{R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q1"]],p:"positive",k:"relation",P:"closes",J:[["q2"]],a:"q3"},O:[null,null,null,"q1",null],F:null}]});
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c),c1:c};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 const wrong=structuredClone(raw);setupFacts(wrong.c1)[0].m.u=["1-1:制御器"];
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


it("validates the complete fictional direct-reference has/path example and rejects definition or group substitution",async()=>{
 const text="白管と黒管を備え、白管から黒管へ流す。",f=fictionalInputs();
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0];
 
 const has={R:0,s:null,m:{u:null,x:"capability",p:"positive",k:"relation",P:"has",J:[["0-0:白管"],["0-0:黒管"]],a:"0-0:備え"},O:[null,null,null,null],F:null};
 const path={R:1,s:null,m:{u:null,x:"operation",p:"positive",k:"path",i:["1-1:白管"],j:["1-1:黒管"],V:[],B:[],e:"whole",r:"route"},O:[null,null,null,null],F:null};
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:[],c1:{possessions:[has],sets:[],f0:[],f1:[groupFact(path)],T:[]}};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 expect(task.system).not.toContain("Q=[");expect(task.system).toContain("possessions=[");
 const definition=structuredClone(raw);Object.assign(definition.c1.f1[0].m,{i:["0-0:白管"],j:["0-0:黒管"]});
 expect((await task.schema.validate!(definition)).success).toBe(false);
 const wrongR=structuredClone(raw);Object.assign(wrongR.c1.f1[0],{R:0});
 expect((await task.schema.validate!(wrongR)).success).toBe(false);
 const wrongGroup=structuredClone(raw);Object.assign(wrongGroup.c1,{f0:[...wrongGroup.c1.f0,...wrongGroup.c1.f1],f1:[]});
 expect((await task.schema.validate!(wrongGroup)).success).toBe(false);
 const unused=structuredClone(raw);Object.assign(unused.c1,{Q:["1-1:流す"]});
 expect((await task.schema.validate!(unused)).success).toBe(false);
 const schema=task.schema.jsonSchema as {definitions:Record<string,{properties?:Record<string,{description?:string}>;anyOf?:{properties:Record<string,{description?:string}>}[]}>};
 expect(schema.definitions.PriorArtSourceGroupedFact.properties).not.toHaveProperty('R');
 const pathSchema=schema.definitions.PriorArtSourceMeaning.anyOf!.find(x=>x.properties.i)!;
 for(const k of ['i','j','V','B'])expect(pathSchema.properties[k].description).toContain('THIS route occurrence');
 expect(pathSchema.properties.u.description).toContain('printed MODE');
});

it("shows existing literal route anchors near the target without supplying completed route meanings",()=>{
 const text="冷媒を白管に流し、冷媒を黒管に流す。",f=fictionalInputs();
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const request=JSON.parse(sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0].prompt);
 expect(request.citationClauses.version).toBe(20);
 expect(request.target.requiredRouteClauses).toEqual([{clause:0,literal:"冷媒を白管に流し、"},{clause:1,literal:"冷媒を黒管に流す。"}]);
 for(const t of request.target.requiredRouteClauses)expect(Object.keys(t).sort()).toEqual(['clause','literal']);
});


it("emits original clause groups without quote declarations or repairing literal references",async()=>{
 const f=setup(),task=f.plan.tasks[0];
 const schema=task.schema.jsonSchema as {definitions:Record<string,{properties:Record<string,unknown>;required:string[]}>};
 const claimSchema=schema.definitions.PriorArtSourceDictionaryClaim;
 expect(Object.keys(claimSchema.properties)).toEqual(["possessions","sets","f0","f1","f2","T"]);
 expect(claimSchema.required).toEqual(["possessions","sets","f0","f1","f2","T"]);
 const original=f.answers[0].value,own=original.c1;
 const ordered={...original,d:task.sourceDigest,scopes:original.scopes,c1:own};
 const before=JSON.stringify(ordered);
 expect((await task.schema.validate!(ordered)).success).toBe(true);
 const stitched=structuredClone(ordered);setupFacts(stitched.c1)[0].m.a="0-2:制御器赤弁";
 expect((await task.schema.validate!(stitched)).success).toBe(false);
 const unused=structuredClone(ordered);Object.assign(unused.c1,{Q:["0-0:御器"]});
 expect((await task.schema.validate!(unused)).success).toBe(false);
 expect(JSON.stringify(ordered)).toBe(before);
});


it("keeps exact state J containing the full passive transition instead of a location noun",()=>{
 const c=sourceReadingClaim(1,"管に接続された。"),action:[number,number]=[0,7];
 const fact={kind:"relation",predicate:"is_state",polarity:"positive",polarityProof:null,action,evidence:c.clauses,objectSpans:[[action]],guardSpans:[],guardProof:null,identity:"fictional"};
 expect(()=>assertSourceSemanticReading(c,[fact],sourceFullActionCues(c))).not.toThrow();
 expect(()=>assertSourceSemanticReading(c,[{...fact,objectSpans:[[[0,2]]]}],sourceFullActionCues(c))).toThrow();
});


it("requires all original clause groups and exact T length without accepting old flat answers",async()=>{
 const f=setup(),raw=f.answers[0].value,task=f.plan.tasks[0];
 const before=JSON.stringify(raw);
 for(const change of [(c:Record<string,unknown>)=>{delete c.f0;},(c:Record<string,unknown>)=>{c.f3=[];},(c:Record<string,unknown>)=>{c.T=[];},(c:Record<string,unknown>)=>{c.T=[0,0];},(c:Record<string,unknown>)=>{c.facts=c.f2;},(c:Record<string,unknown>)=>{(c.f2 as Record<string,unknown>[])[0].R=2;}]){
  const bad=structuredClone(raw);change(bad.c1);expect((await task.schema.validate!(bad)).success).toBe(false);
 }
 expect((await task.schema.validate!(raw)).success).toBe(true);expect(JSON.stringify(raw)).toBe(before);
 expect(task.system).not.toContain("facts is flat");
});
it("projects explicit opposite-mode scopes into exactly the strict original meanings without changing the controller",async()=>{
 const f=fictionalInputs(),text="制御器により、赤弁を閉じる冬モードと、赤弁を開く夏モード。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks),input=propositionSourceInput(chunks);
 const original={Q:["q0|0-0:制御器","q1|1-1:赤弁","q2|1-1:閉じる","q3|1-1:冬モード","q4|2-2:赤弁","q5|2-2:開く","q6|2-2:夏モード"],facts:[
  {R:1,m:{u:["q0"],x:"operation",g:"when",G:[["q3"]],p:"positive",k:"relation",P:"closes",J:[["q1"]],a:"q2"},O:[null,null,null,"q3",null],F:null},
  {R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q6"]],p:"positive",k:"relation",P:"opens",J:[["q4"]],a:"q5"},O:[null,null,null,"q6",null],F:null}]};
 const answers=plan.tasks.map(task=>{const claim=fictionalQuotationClaim(sourceReadingClaim(1,text),structuredClone(original));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(claim),c1:claim}};});
 const legacy={v:22,s:input.sources.map(s=>({d:s.sourceDigest,c1:structuredClone(original)}))},validated=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(legacy);expect(validated.success).toBe(true);if(!validated.success)throw validated.error;
 const actual=await assembleSourceClaims(plan,answers);expect(actual).toEqual(validated.value);
 const decoded=decodeSourcePropositions(chunks,actual);expect(decoded).toEqual(decodeSourcePropositions(chunks,validated.value));
 expect(answers[0].value.scopes).toHaveLength(2);
 const before=JSON.stringify(answers);await assembleSourceClaims(plan,answers);expect(JSON.stringify(answers)).toBe(before);
});
it("rejects exact refrigerant heat objects while retaining the actual component and governing actor",async()=>{
 const f=fictionalInputs(),text="制御器は、冷媒を青放熱器にて放熱させる。";f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0];
 const claim=fictionalQuotationClaim(sourceReadingClaim(1,text),{Q:['q0|0-0:制御器','q1|1-1:青放熱器','q2|1-1:放熱させる'],facts:[{R:1,m:{u:['q0'],x:'operation',g:'unconditional',G:[],p:'positive',k:'relation',P:'releases_heat',J:[['q1']],a:'q2'},O:[null,null,null,null,null],F:null}]});
 const raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(claim),c1:claim};expect((await task.schema.validate!(raw)).success).toBe(true);
 const bad=structuredClone(raw);(bad.c1.f1 as {m:{J:string[][]}}[])[0].m.J=[['1-1:冷媒']];const before=JSON.stringify(bad);expect((await task.schema.validate!(bad)).success).toBe(false);expect(JSON.stringify(bad)).toBe(before);
 const schema=task.schema.jsonSchema as {definitions:Record<string,{anyOf?:{properties:Record<string,{description?:string}>}[]}>};expect(schema.definitions.PriorArtSourceMeaning.anyOf!.find(x=>x.properties.J)!.properties.J.description).toContain('never refrigerant');
});
it("shows actual adjacent raw context and mode scopes without accepting stitched context roles",async()=>{const f=setup(),task=f.plan.tasks[0];expect(task.system).toContain('{reference:"0-0:と青管。",focus:"青管"}');expect(task.system).toContain('Outer locator text adds no semantic evidence');expect(task.system).toContain('proof:"1-1:冬モード"');const raw=structuredClone(f.answers[0].value);(raw.c1.f2 as {O:unknown[]}[])[0].O[3]='0-2:制御器は、赤弁を閉じる';const before=JSON.stringify(raw);expect((await task.schema.validate!(raw)).success).toBe(false);expect(JSON.stringify(raw)).toBe(before);});

it("rejects the historical answer wrapper without flattening or raw repair",async()=>{const f=setup(),value=f.answers[0].value;const {v,sourceDigest,claimNo,...answer}=value;const old={v:31,sourceDigest,claimNo,answer};const before=JSON.stringify(old);expect((await f.plan.tasks[0].schema.validate!(old)).success).toBe(false);expect(JSON.stringify(old)).toBe(before);expect(v).toBe(34);});

it("keeps the complete duration in G even when the proof already contains it",async()=>{
 const f=fictionalInputs(),text="制御器は、起動時、所定期間、赤弁を閉じる。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0],reading=sourceReadingClaim(1,text);
 const legacy={Q:["q0|0-0:制御器","q1|1-1:起動時","q2|2-2:所定期間","q3|1-2:起動時、所定期間、","q4|3-3:赤弁","q5|3-3:閉じる"],facts:[{R:3,m:{u:["q0"],x:"operation",g:"when",G:[["q1"],["q2"]],p:"positive",k:"relation",P:"closes",J:[["q4"]],a:"q5"},O:[null,null,null,"q3",null],F:null}]};
 const c1=fictionalQuotationClaim(reading,legacy),raw={v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1};
 expect((await task.schema.validate!(raw)).success).toBe(true);
 expect((raw.scopes[0] as {G:string[][]}).G).toEqual([["1-1:起動時"],["2-2:所定期間"]]);
 for(const replacement of ["3-3:赤弁"]){const bad=structuredClone(raw);(bad.scopes[0] as {G:string[][]}).G[1]=[replacement];const before=JSON.stringify(bad);expect((await task.schema.validate!(bad)).success).toBe(false);expect(JSON.stringify(bad)).toBe(before);}
});

it("rejects the preceding flat v33 wire without changing its raw body",async()=>{const f=setup(),old={...f.answers[0].value,v:33},before=JSON.stringify(old);expect((await f.plan.tasks[0].schema.validate!(old)).success).toBe(false);expect(JSON.stringify(old)).toBe(before);});
it("preserves the exact same unique original span when optional context is supplied",async()=>{const f=setup(),raw=structuredClone(f.answers[0].value);setupFacts(raw.c1)[0].m.a={reference:"2-2:赤弁を閉じる。",focus:"閉じる"} as unknown as string;expect((await f.plan.tasks[0].schema.validate!(raw)).success).toBe(true);const bad=structuredClone(raw);setupFacts(bad.c1)[0].m.a={reference:"2-2:赤弁を閉じる。",focus:"閉じる架空"} as unknown as string;const before=JSON.stringify(bad);expect((await f.plan.tasks[0].schema.validate!(bad)).success).toBe(false);expect(JSON.stringify(bad)).toBe(before);});

it("requires the model to disambiguate a repeated component with exact enclosing text",async()=>{
 const f=fictionalInputs(),text="赤弁を備える赤弁制御装置。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const plan=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection));
 const answers=plan.tasks.map(task=>({taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:[],c1:{
  possessions:[{R:0,s:null,m:{u:["0-0:赤弁制御装置"],x:"capability",p:"positive",k:"relation",P:"has",J:[[{reference:"0-0:赤弁を",focus:"赤弁"}]],a:"0-0:備える"},O:[null,null,null,null],F:null}],sets:[],f0:[],T:[],
 }}}));
 const before=JSON.stringify(answers),actual=await assembleSourceClaims(plan,answers);
 expect(JSON.stringify(answers)).toBe(before);
 const decoded=decodeSourcePropositions(makePlan(f.inputs,f.selection),actual);
 expect(decoded.facts.length).toBeGreaterThan(0);
 expect(decoded.facts.every(f=>f.meaning.kind==="relation"&&f.meaning.objects.join()==="赤弁")).toBe(true);
 const bad=structuredClone(answers[0].value);
 bad.c1.possessions[0].m.J=[["0-0:赤弁" as unknown as {reference:string;focus:string}]];
 const unchanged=JSON.stringify(bad);
 expect((await plan.tasks[0].schema.validate!(bad)).success).toBe(false);
 expect(JSON.stringify(bad)).toBe(unchanged);
});

it.each(["before","after"])("retains both coordinated action operands and their printed actor %s the function through the strict decoder",async position=>{
 const after=position==="after",first=after?0:1,last=after?1:2;
 const f=fictionalInputs(),text=after?"青工程と、赤工程を切り換えて実行する読取装置。":"制御器は、青工程と、赤工程を切り換えて実行する。";f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),reading=sourceReadingClaim(1,text),legacy={Q:[after?"q0|1-1:読取装置":"q0|0-0:制御器",`q1|${first}-${first}:青工程`,`q2|${last}-${last}:赤工程を切り換えて実行する`,`q3|${last}-${last}:切り換えて実行する`],facts:[{R:last,m:{u:["q0"],x:after?"capability":"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"executes",J:[["q1"],["q2"]],a:"q3"},O:[null,null,null,null,null],F:null}]};
 const plan=sourceClaimExtractionPlan(chunks),answers=plan.tasks.map(task=>{const c1=fictionalQuotationClaim(reading,structuredClone(legacy));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};});
 const assembled=await assembleSourceClaims(plan,answers),expected={v:22,s:propositionSourceInput(chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(legacy)}))},validated=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);expect(validated.success).toBe(true);if(!validated.success)throw validated.error;expect(assembled).toEqual(validated.value);expect(decodeSourcePropositions(chunks,assembled)).toEqual(decodeSourcePropositions(chunks,validated.value));
 const missingAction=structuredClone(answers[0].value);
 (missingAction.c1[`f${last}`] as {m:{J:string[][]}}[])[0].m.J=[[`${first}-${first}:青工程`],[`${last}-${last}:赤工程`]];
 const before=JSON.stringify(missingAction);
 expect((await plan.tasks[0].schema.validate!(missingAction)).success).toBe(false);
 expect(JSON.stringify(missingAction)).toBe(before);
 await expect(assembleSourceClaims(plan,[{...answers[0],value:missingAction},...answers.slice(1)])).rejects.toThrow();
});

it("preserves explicit continuing actors and the new passive subject without decoder inheritance",async()=>{
 const f=fictionalInputs(),text="制御器により、青板を研磨材で研磨し、青板を布で拭く。赤管は白管に接続された。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),reading=sourceReadingClaim(1,text);
 const legacy={Q:["q0|0-0:制御器","q1|1-1:青板を研磨材で研磨し","q2|2-2:青板を布で拭く","q3|3-3:赤管","q4|3-3:白管に接続された","q5|3-3:接続された"],facts:[
  {R:1,m:{u:["q0"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"executes",J:[["q1"]],a:"q1"},O:[null,null,null,null,null],F:null},
  {R:2,m:{u:["q0"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"executes",J:[["q2"]],a:"q2"},O:[null,null,null,null,null],F:null},
  {R:3,m:{u:["q3"],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"is_state",J:[["q4"]],a:"q5"},O:[null,null,null,null,null],F:null}]};
 const plan=sourceClaimExtractionPlan(chunks),answers=plan.tasks.map(task=>{
  const c1=fictionalQuotationClaim(reading,structuredClone(legacy));
  return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};
 });
 const before=JSON.stringify(answers),actual=await assembleSourceClaims(plan,answers);
 const expected={v:22,s:propositionSourceInput(chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(legacy)}))};
 const validated=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);
 expect(validated.success).toBe(true);if(!validated.success)throw validated.error;
 expect(actual).toEqual(validated.value);expect(JSON.stringify(answers)).toBe(before);
 expect(decodeSourcePropositions(chunks,actual)).toEqual(decodeSourcePropositions(chunks,validated.value));
});

it("keeps cross-clause action ranges independent of the fact group and mode-scoped controller",async()=>{
 const f=fictionalInputs(),text="制御器により、青板を、研磨材で研磨する冬モードと、青板を、布で拭く夏モード。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),reading=sourceReadingClaim(1,text),plan=sourceClaimExtractionPlan(chunks);
 const legacy={Q:["q0|0-0:制御器","q1|1-2:青板を、研磨材で研磨する","q2|2-2:研磨する","q3|2-2:冬モード","q4|3-4:青板を、布で拭く","q5|4-4:拭く","q6|4-4:夏モード"],facts:[
  {R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q3"]],p:"positive",k:"relation",P:"executes",J:[["q1"]],a:"q2"},O:[null,null,null,"q3",null],F:null},
  {R:4,m:{u:["q0"],x:"operation",g:"when",G:[["q6"]],p:"positive",k:"relation",P:"executes",J:[["q4"]],a:"q5"},O:[null,null,null,"q6",null],F:null}]};
 const answers=plan.tasks.map(task=>{const c1=fictionalQuotationClaim(reading,structuredClone(legacy));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};});
 const before=JSON.stringify(answers),actual=await assembleSourceClaims(plan,answers),expected={v:22,s:propositionSourceInput(chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(legacy)}))},checked=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);
 expect(checked.success).toBe(true);if(!checked.success)throw checked.error;expect(actual).toEqual(checked.value);expect(JSON.stringify(answers)).toBe(before);
 for(const [group,ref]of [["f2","2-2:青板を、研磨材で研磨する"],["f4","4-4:青板を、布で拭く"]]){
  const bad=structuredClone(answers[0].value);(bad.c1[group] as {m:{J:string[][]}}[])[0].m.J=[[ref]];const raw=JSON.stringify(bad);
  expect((await plan.tasks[0].schema.validate!(bad)).success).toBe(false);expect(JSON.stringify(bad)).toBe(raw);
 }
});

it.each([0,25])("keeps each causative mode action beside heat/paths, including cross-partition actors and guards (%i prefix clauses)",async padding=>{
 const f=fictionalInputs(),r=padding+1,h=r+1,p=r+2,s=r+3,state=r+4,modeName=padding?"第２の運転モード":"夏モード";
 const text="制御器により、"+Array.from({length:padding},(_,i)=>`青弁${i}を開く、`).join("")+`液を白弁で減圧した後、液を白吸熱器にて吸熱させ、液を槽に流し、槽から源に吸い込ませる${modeName}である。赤管は白管に接続された。`;
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),reading=sourceReadingClaim(1,text),plan=sourceClaimExtractionPlan(chunks),Q:string[]=[];
 const q=(at:number,literal:string,last=at)=>{const id=`q${Q.length}`;Q.push(`${id}|${at}-${last}:${literal}`);return id;};
 const controller=q(0,"制御器"),mode=q(s,modeName),after=q(r,"液を白弁で減圧した後");
 const proof=q(r,`液を白弁で減圧した後、液を白吸熱器にて吸熱させ、液を槽に流し、槽から源に吸い込ませる${modeName}`,s);
 const base=(u:string,g:string[][])=>({u:[u],x:"operation",g:"when",G:g,p:"positive"});
 const operation=(R:number,action:string,afterReduction:boolean)=>{const a=q(R,action);return {R,m:{...base(controller,afterReduction?[[mode],[after]]:[[mode]]),k:"relation",P:"executes",J:[[a]],a},O:[null,null,null,afterReduction?proof:mode,null],F:null};};
 const path=(R:number,origin:string,destination:string)=>({R,m:{...base(mode,[[mode],[after]]),k:"path",i:[q(R,origin)],j:[q(R,destination)],V:[],B:[],e:"whole",r:"route"},O:[null,null,null,proof,null],F:null});
 const facts=[
  ...Array.from({length:padding},(_,i)=>({R:i+1,m:{...base(controller,[[mode]]),k:"relation",P:"opens",J:[[q(i+1,`青弁${i}`)]],a:q(i+1,"開く")},O:[null,null,null,mode,null],F:null})),
  operation(r,"液を白弁で減圧した",false),
  {R:h,m:{...base(mode,[[mode],[after]]),k:"relation",P:"absorbs_heat",J:[[q(h,"白吸熱器")]],a:q(h,"吸熱させ")},O:[null,null,null,proof,null],F:null},operation(h,"液を白吸熱器にて吸熱させ",true),
  path(p,"液","槽"),operation(p,"液を槽に流し",true),path(s,"槽","源"),operation(s,"槽から源に吸い込ませる",true),
  {R:state,m:{u:[q(state,"赤管")],x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"is_state",J:[[q(state,"白管に接続された")]],a:q(state,"接続された")},O:[null,null,null,null,null],F:null},
 ];
 const legacy={Q,facts},whole=fictionalQuotationClaim(reading,structuredClone(legacy)),allScopes=fictionalScopesFor(whole) as {id:string}[];
 const answers=plan.tasks.map(task=>{
  const request=JSON.parse(task.prompt),ids:number[]=request.target.partition?.clauseIds??reading.clauses.map((_,i)=>i);
  const c1={possessions:[],sets:[],...Object.fromEntries(ids.map(id=>[`f${id}`,structuredClone(whole[`f${id}`])])),T:request.target.obligations.map((o:{key:string})=>whole.T[Number(o.key.slice(1))])};
  const used=new Set(ids.flatMap(id=>(c1[`f${id}` as keyof typeof c1] as unknown as {s:string|null}[]).map(row=>row.s)));
  return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:allScopes.filter(scope=>used.has(scope.id)),c1}};
 });
 expect(plan.tasks).toHaveLength(padding?9:3);
 const before=JSON.stringify(answers),actual=await assembleSourceClaims(plan,answers);
 const expected={v:22,s:propositionSourceInput(chunks).sources.map(source=>({d:source.sourceDigest,c1:structuredClone(legacy)}))};
 const checked=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);expect(checked.success).toBe(true);if(!checked.success)throw checked.error;
 expect(actual).toEqual(checked.value);expect(JSON.stringify(answers)).toBe(before);
 for(const clause of [h,p,s]){
  const index=plan.tasks.findIndex(t=>JSON.parse(t.prompt).target.obligations.some((o:{clause:number;predicate:string})=>o.clause===clause&&o.predicate==="executes"));
  const task=plan.tasks[index],bad=structuredClone(answers[index].value),key=`f${clause}`;
  (bad.c1 as Record<string,unknown>)[key]=(bad.c1 as Record<string,{m:{P?:string}}[]>)[key].filter(row=>row.m.P!=="executes");
  // Try to credit the remaining heat/path row for the missing independent action.
  bad.c1.T=bad.c1.T.map((address:string)=>address===`${key}:1`?`${key}:0`:address);
  const raw=JSON.stringify(bad);expect((await task.schema.validate!(bad)).success).toBe(false);expect(JSON.stringify(bad)).toBe(raw);
  await expect(assembleSourceClaims(plan,answers.map((answer,i)=>i===index?{...answer,value:bad}:answer))).rejects.toThrow();
 }
});

it("partitions complex claims with common full context and accepts only their complete strict union",async()=>{
 const f=fictionalInputs(),text="制御器により、"+Array.from({length:29},(_,i)=>`青弁${i+1}を開く、`).join("")+"冬モード。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const reading=sourceReadingClaim(1,text),chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks);
 const legacy={Q:["q0|0-0:制御器","q1|30-30:冬モード",...Array.from({length:29},(_,i)=>[`q${2+i*2}|${i+1}-${i+1}:青弁${i+1}`,`q${3+i*2}|${i+1}-${i+1}:開く`]).flat()],facts:Array.from({length:29},(_,i)=>({R:i+1,m:{u:["q0"],x:"operation",g:"when",G:[["q1"]],p:"positive",k:"relation",P:"opens",J:[[`q${2+i*2}`]],a:`q${3+i*2}`},O:[null,null,null,"q1",null],F:null}))};
 const whole=fictionalQuotationClaim(reading,structuredClone(legacy));
 expect(plan.tasks).toHaveLength(9);
 const answers=plan.tasks.map(task=>{
  const p=JSON.parse(task.prompt),ids=p.target.partition.clauseIds as number[];
  const c1={possessions:[],sets:[],...Object.fromEntries(ids.map(id=>[`f${id}`,structuredClone(whole[`f${id}`])])),T:p.target.obligations.map((o:{key:string})=>whole.T[Number(o.key.slice(1))])};
  expect(p.sourceContext.source.claims[0].clauses.map((v:[number,string])=>v[1]).join("")).toBe(text);
  return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(whole),c1}};
 });
 const before=JSON.stringify(answers);
 for(const[i,task]of plan.tasks.entries())expect((await task.schema.validate!(answers[i].value)).success).toBe(true);
 const expected={v:22,s:propositionSourceInput(chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(legacy)}))};
 const checked=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);expect(checked.success).toBe(true);if(!checked.success)throw checked.error;
 expect(await assembleSourceClaims(plan,[...answers].reverse())).toEqual(checked.value);
 expect(JSON.stringify(answers)).toBe(before);
 await expect(assembleSourceClaims(plan,answers.slice(1))).rejects.toThrow();
 await expect(assembleSourceClaims(plan,[answers[0],...answers.slice(0,-1)])).rejects.toThrow();
 const extra=structuredClone(answers[1].value);Object.assign(extra.c1,{f0:[]});expect((await plan.tasks[1].schema.validate!(extra)).success).toBe(false);
 const missing=structuredClone(answers[1].value);Object.assign(missing.c1,{f16:[]});expect((await plan.tasks[1].schema.validate!(missing)).success).toBe(false);
});

it("preserves scattered possession heads and their separate function, splitting only the actual support union",async()=>{
 const f=fictionalInputs(),members=["青センサ","乙部材","丙部材","丁部材","戊部材","己部材","庚部材","辛部材","壬部材","癸部材","子部材","丑部材","制御器"];
 const text="温度を検出する"+members.join("と、")+"を備える。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),reading=sourceReadingClaim(1,text),plan=sourceClaimExtractionPlan(chunks);
 expect(reading.clauses).toHaveLength(13);
 const possession=(indices:number[])=>({R:12,m:{u:null,x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"has",J:indices.map(i=>[`q${i}`]),a:"q13"},O:[null,null,null,null,null],F:null});
 const legacy={Q:[...members.map((name,i)=>`q${i}|${i}-${i}:${name}`),"q13|12-12:備える","q14|0-0:温度を検出する"],facts:[
  {R:0,m:{u:["q0"],x:"capability",g:"unconditional",G:[],p:"positive",k:"relation",P:"executes",J:[["q14"]],a:"q14"},O:[null,null,null,null,null],F:null},
  possession([0,2,12]),possession([1,3,4,5,6,7,8,9,10,11])]};
 const answers=plan.tasks.map(task=>{const c1=fictionalQuotationClaim(reading,structuredClone(legacy));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};});
 const before=JSON.stringify(answers),actual=await assembleSourceClaims(plan,answers);
 const expected={v:22,s:propositionSourceInput(chunks).sources.map(s=>({d:s.sourceDigest,c1:structuredClone(legacy)}))};
 const validated=await sourceIdentifiedPropositionModelSchemaFor(chunks).validate!(expected);
 expect(validated.success).toBe(true);if(!validated.success)throw validated.error;
 expect(actual).toEqual(validated.value);expect(JSON.stringify(answers)).toBe(before);
 expect(decodeSourcePropositions(chunks,actual)).toEqual(decodeSourcePropositions(chunks,validated.value));
 const bad=structuredClone(answers[0].value),rows=bad.c1.possessions as {m:{J:string[][]}}[];
 // Twelve heads plus the verb's distinct thirteenth clause exceed support capacity,
 // even though each individual reference and the twelve-object array fit.
 rows[0].m.J=members.slice(0,12).map((name,i)=>[`${i}-${i}:${name}`]);
 rows[1].m.J=[["12-12:制御器"]];
 const badBefore=JSON.stringify(bad);
 expect((await plan.tasks[0].schema.validate!(bad)).success).toBe(false);
 expect(JSON.stringify(bad)).toBe(badBefore);
});


it("keeps the recognized whole-route mode subject distinct from its controller without weakening the fixed-frame decoder",async()=>{
 const f=fictionalInputs(),body="制御器により、前記分岐器から出た気体を、前記混合器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記混合器に流し、前記分岐器から前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${body}`,11,"架空");f.selection.draftClaimNos=[1];
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource("【請求項1】装置は信号を保持する。",d.id,d.label));
 const chunks=makePlan(f.inputs,f.selection),source=propositionSourceInput(chunks).sources[0],claim=source.source.claims[0],frame=source.recognizedLoopRoutes[0];
 expect(frame).toBeDefined();
 const {validateDirectSourceClaim}=await import("./source-direct-quotes"),{sourceCitationGrid,sourceCellRef}=await import("./source-citation-grid");
 const claimText=claim.segments.map(p=>p.text).join(""),grid=sourceCitationGrid(claimText),q=(span:readonly[number,number])=>({cells:sourceCellRef(grid,[...span])});
 const direct={sourceDigest:source.sourceDigest,c1:[],loop0:{claimNo:1,basis:{firstPart:frame.basisParts[0],lastPart:frame.basisParts[1]},meaning:{subject:[q(frame.mode)],context:"operation",guardRelation:"unconditional",guardConditions:[],polarity:"positive",kind:"path",origin:[q(frame.entry)],destination:[q(frame.exit)],via:[],bypass:[],extent:"whole",relation:"route"},operators:null,routeFrame:0}};
 const before=JSON.stringify(direct);await expect(validateDirectSourceClaim(source,1,direct,SOURCE_CAPACITY)).resolves.toBeDefined();expect(JSON.stringify(direct)).toBe(before);
 const wrong=structuredClone(direct),controller:[number,number]=[claimText.indexOf("制御器"),claimText.indexOf("制御器")+3];wrong.loop0.meaning.subject=[q(controller)];const wrongBefore=JSON.stringify(wrong);
 await expect(validateDirectSourceClaim(source,1,wrong,SOURCE_CAPACITY)).rejects.toThrow();expect(JSON.stringify(wrong)).toBe(wrongBefore);
 const task=sourceClaimExtractionPlan(chunks).tasks.find(t=>t.sourceIndex===0)!;
 const defs=(task.schema.jsonSchema as {definitions:Record<string,{anyOf?:{properties?:Record<string,{description?:string}>}[]}>}).definitions;
 const branches=defs.PriorArtSourceMeaning.anyOf!;expect(branches.find(b=>b.properties?.i)?.properties?.u.description).toContain("fixed recognizedLoopRoutes mode");
 expect(task.system).toContain("A return path and switching action in the same clause are distinct meanings");
});


it("preserves the operation discriminator independently of a device claim and its mode guard",async()=>{
 const f=fictionalInputs(),text="制御器により、赤弁を閉じる冬モードと、赤弁を開く夏モード。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const chunks=makePlan(f.inputs,f.selection),plan=sourceClaimExtractionPlan(chunks);
 const original={Q:["q0|0-0:制御器","q1|1-1:赤弁","q2|1-1:閉じる","q3|1-1:冬モード","q4|2-2:赤弁","q5|2-2:開く","q6|2-2:夏モード"],facts:[
  {R:1,m:{u:["q0"],x:"operation",g:"when",G:[["q3"]],p:"positive",k:"relation",P:"closes",J:[["q1"]],a:"q2"},O:[null,null,null,"q3",null],F:null},
  {R:2,m:{u:["q0"],x:"operation",g:"when",G:[["q6"]],p:"positive",k:"relation",P:"opens",J:[["q4"]],a:"q5"},O:[null,null,null,"q6",null],F:null}]};
 const answers=plan.tasks.map(task=>{const c1=fictionalQuotationClaim(sourceReadingClaim(1,text),structuredClone(original));return{taskId:task.id,value:{v:34,sourceDigest:task.sourceDigest,claimNo:1,d:task.sourceDigest,scopes:fictionalScopesFor(c1),c1}};});
 const before=JSON.stringify(answers),actual=decodeSourcePropositions(chunks,await assembleSourceClaims(plan,answers));
 const propertyAnswers=structuredClone(answers);for(const answer of propertyAnswers)for(const k of ["f1","f2"])for(const row of answer.value.c1[k] as {m:{x:string}}[])row.m.x="capability";
 const properties=decodeSourcePropositions(chunks,await assembleSourceClaims(plan,propertyAnswers));
 expect(properties).not.toEqual(actual);expect(JSON.stringify(actual)).toContain('"context":"operation"');expect(JSON.stringify(properties)).toContain('"context":"capability"');expect(JSON.stringify(answers)).toBe(before);
 expect(plan.tasks[0].system).toContain("A device claim does not turn its mode operations into capabilities");
 const schema=plan.tasks[0].schema.jsonSchema as {definitions:Record<string,{anyOf?:{properties:Record<string,{description?:string}>}[]}>};
 for(const branch of schema.definitions.PriorArtSourceMeaning.anyOf!)expect(branch.properties.x.description).toContain("Choose context for THIS assertion");
});


it("limits the canonical set exception to exact supplied sets and preserves other meanings",()=>{
 const f=fictionalInputs(),text="前記第１の運転モードは光モードであり、光モードでは青弁を開き、青センサ又は赤センサを備える装置。";
 f.inputs.draft=parseComparisonSource(`【請求項1】${text}`,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(`【請求項1】${text}`,d.id,"架空"));
 const task=sourceClaimExtractionPlan(makePlan(f.inputs,f.selection)).tasks[0],request=JSON.parse(task.prompt);
 expect(request.sourceContext.source.claims[0].canonicalModeSets).toEqual([{subject:"第１の運転モード",selection:"required",extent:"closed",members:["光モード"]}]);
 expect(request.sourceContext.source.claims[0].clauses.map(([,v]:[number,string])=>v).join("")).toBe(text);
 const schema=task.schema.jsonSchema as {definitions:Record<string,{properties:Record<string,{description?:string;items?:unknown;maxItems?:number}>}>};
 const sets=schema.definitions.PriorArtSourceDictionaryClaim.properties.sets;
 const instruction="Skip a set ONLY when its subject, selection, extent and complete members exactly match";
 expect(task.system).toContain(instruction);expect(sets.description).toContain(instruction);
 for(const contract of [task.system,sets.description!]){
  expect(contract).toContain("Emit every other noncanonical set, including a set differing in any of those fields");
  expect(contract).toContain("retain all nearby functions, actions, routes and guards");
  expect(contract).toContain("Never omit a set merely because it mentions a supplied mode or member");
 }
 expect(sets.items).toEqual({$ref:"#/definitions/PriorArtSourceLaneFact"});expect(sets.maxItems).toBeUndefined();
 const ordinary=setup().plan.tasks[0];
 const ordinarySchema=ordinary.schema.jsonSchema as typeof schema;
 expect(ordinary.system).not.toContain(instruction);
 expect(ordinarySchema.definitions.PriorArtSourceDictionaryClaim.properties.sets.description).toBe("Every quantified member/alternative set assertion, including any/combinations/all. Only set facts with explicit selection and original R nondecreasing. Enumeration of operations never replaces selection.");
});
