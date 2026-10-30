import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceCitedPropositionModelSchemaFor,propositionSourceCitedTransport} from "./source-semantic-wire";
import {sourceDeclaredEvidence,sourceMatchedTasks,sourceReadingTasks,resolveSourceTaskQuote} from "./source-reading-tasks";
import {sourceReadingClaim} from "./source-clause-coverage";
const neutral=()=>({selection:null,extent:null,polarity:null,guard:null,context:null});
const close=()=>({m:{u:["0:制御器"],x:"operation",g:"when",G:[["1:非通電状態の場合"]],p:"positive",k:"relation",P:"closes",J:[["2:赤弁"]],a:"2:閉じる"},O:{...neutral(),guard:{first:1,last:1},context:{first:0,last:2}},F:null});
function setup(text="制御器は、非通電状態の場合、赤弁を閉じる。",facts:unknown[]=[close()]){
 const f=fictionalInputs(),original="【請求項1】"+text;
 f.inputs.draft=parseComparisonSource(original,11,"架空");
 f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(original,d.id,"架空"));
 const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
 return {plan,input,model:sourceCitedPropositionModelSchemaFor(plan),wire:{v:19,s:input.sources.map(s=>({d:s.sourceDigest,c1:structuredClone(facts)}))}};
}
it("derives only explicitly cited evidence and actual task matches without changing an answer",async()=>{
 const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
 expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);
 if(r.success)expect(decodeSourcePropositions(f.plan,r.value).facts.some(p=>p.meaning.kind==="relation"&&p.meaning.predicate==="closes")).toBe(true);
 expect(propositionSourceCitedTransport(f.input).citationClauses.version).toBe(4);
 expect(sourceDeclaredEvidence(sourceReadingClaim(1,"制御器は、非通電状態の場合、赤弁を閉じる。"),close())).toEqual([0,1,2]);
});
it.each(["W","T","wrong_clause","false_quote","missing_operator","unrepresented_clause","legacy_version"])("rejects %s without repair",async mode=>{
 const f=setup(),p=f.wire.s[0].c1[0] as ReturnType<typeof close> & Record<string,unknown>;
 if(mode==="W")p.W=[0,1,2];if(mode==="T")p.T=[0];
 if(mode==="wrong_clause")p.m.a="0:閉じる";
 if(mode==="false_quote")p.m.G=[["1:通電時の場合"]];
 if(mode==="missing_operator")(p.O as Record<string,unknown>).guard=null;
 if(mode==="unrepresented_clause"){p.m.u=[];p.O.context={first:1,last:2};}
 if(mode==="legacy_version")f.wire.v=18;
 expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("bounds explicit clause inventories and never borrows a different clause occurrence",()=>{
 const c=sourceReadingClaim(1,Array.from({length:14},(_,i)=>`部品${i}。`).join(""));
 const f={m:{u:null,G:[],J:[["0:部品0"]]},O:{...neutral(),context:{first:0,last:12}},F:null};
 expect(()=>sourceDeclaredEvidence(c,f)).toThrow();
 f.O.context={first:0,last:11};f.m.J=[["13:部品13"]];expect(()=>sourceDeclaredEvidence(c,f)).toThrow();
 expect(()=>resolveSourceTaskQuote(c,"0:部品13",[0,13])).toThrow();
});
it("keeps independent route, heat and opening obligations without generated task indices",()=>{
 const c=sourceReadingClaim(1,"冷媒を青管から赤放熱器に流して放熱させ、白吸熱器で吸熱させ、赤弁を開く。"),tasks=sourceReadingTasks(c,true);
 const q=(v:string)=>resolveSourceTaskQuote(c,v,[0,1,2]);
 expect(tasks.map(t=>t.kind)).toEqual(["path","releases_heat","absorbs_heat","opens"]);
 expect(sourceMatchedTasks(tasks,{k:"path",r:"route",p:"positive"},[0,1,2],null,[q("0:青管")])).toEqual([0]);
 expect(sourceMatchedTasks(tasks,{k:"relation",P:"releases_heat",p:"positive"},[0,1,2],q("0:放熱させ"),[])).toEqual([1]);
});
it.each(["赤弁を開いた後、装置を停止する。","赤弁を開く場合、装置を停止する。","赤弁を開くとき、装置を停止する。","赤弁を開く必要がない。","赤弁を開くことはありません。","赤弁を開くな。","電源が供給される場合、装置を停止する。","電源が供給されない。","非通電とされない。","配管に接続された場合、装置を停止する。","電源が供給されると、赤弁を開く場合がある。","電源が供給されれば、装置を停止する。","非通電とされても、装置を停止しない。"])("does not invent an asserted event from %s",text=>{
 expect(sourceReadingTasks(sourceReadingClaim(1,text),true).filter(t=>t.kind.startsWith("opens")||t.kind==="is_state")).toEqual([]);
});
it("requires an actual opening, and keeps passive restoration distinct from closing",async()=>{
 const relation=(P:string,J:string,a:string)=>({m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P,J:[[J]],a},O:neutral(),F:null});
 const f=setup("赤弁を開き、閉じた状態に復帰する。",[relation("opens","0:赤弁","0:開き"),relation("is_state","1:閉じた状態に復帰する","1:閉じた状態に復帰する")]);
 expect((await f.model.validate!(f.wire)).success).toBe(true);
 f.wire.s[0].c1.shift();expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("rejects positive state prefixes sliced out of negation and conditional premises",async()=>{
 for(const suffix of ["ない","る場合","た場合","ると","れば","ても","た後","続けた場合"]){
  const f=setup(`電源が供給され${suffix}。`,[{m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"is_state",J:[["0:電源が供給され"]],a:"0:電源が供給され"},O:neutral(),F:null}]);
  expect((await f.model.validate!(f.wire)).success).toBe(false);
 }
});
it("recognizes a continued assertion and a directly modified connection component",()=>{
 for(const text of ["電源が供給され続け、","吸込側に接続されたアキュムレータと、"])
  expect(sourceReadingTasks(sourceReadingClaim(1,text),true).filter(t=>t.kind==="is_state")).toHaveLength(1);
 for(const text of ["非通電とされた場合、","電源が供給された場合、","閉じた状態に復帰する場合、"])
  expect(sourceReadingTasks(sourceReadingClaim(1,text),true)).toEqual([]);
});
it("includes only an explicitly selected fixed frame and still requires its valve actions",async()=>{
 const text="前記分岐器から出た気体を、前記冷却器を経ること無く前記蓄積器に流すための第２の開閉弁と、"+
 "前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記加熱器に流し、"+
 "前記分岐器から前記バイパス配管を通って前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、別経路を実行する第２の運転モードを切り換える。";
 const f=setup(text,[]);
 const wire={v:19,s:f.input.sources.map(s=>{
  const r=s.recognizedLoopRoutes[0];expect(r).toBeDefined();
  const relation=(id:number,P:string,a:string,J:string)=>({m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P,J:[[`${id}:${J}`]],a:`${id}:${a}`},O:neutral(),F:null});
  return {d:s.sourceDigest,c1:[relation(2,"closes","閉じ","第１の開閉弁"),relation(3,"opens","開く","第２の開閉弁")],loop0:{n:1,b:{a:r.basisParts[0],z:r.basisParts[1]},
   m:{u:["6:第１の運転モード"],x:"operation",g:"unconditional",G:[],p:"positive",k:"path",i:["4:送出器"],j:["6:送出器"],V:[["4:加熱器"],["5:分岐器"],["5:バイパス配管"],["5:蓄積器"]],B:[["1:冷却器"]],e:"whole",r:"route"},O:{...neutral(),context:{first:0,last:7}},F:0}};
 })};
 expect((await f.model.validate!(wire)).success).toBe(true);
 wire.s[0].loop0.F=99;expect((await f.model.validate!(wire)).success).toBe(false);
});
