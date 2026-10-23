import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceTaskPropositionModelSchemaFor,propositionSourceTaskTransport} from "./source-semantic-wire";
import {assertSourceTaskBindings,resolveSourceTaskQuote,sourceConsecutiveIds,sourceReadingTasks} from "./source-reading-tasks";
import {sourceReadingClaim} from "./source-clause-coverage";
const neutral=()=>({selection:null,extent:null,polarity:null,guard:null,context:null});
function setup(text="制御器は、非通電状態の場合、赤弁を閉じる。"){
  const f=fictionalInputs(),source="【請求項1】"+text;
  f.inputs.draft=parseComparisonSource(source,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(source,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  const fact={T:[0],m:{u:["0:制御器"],x:"operation",g:"when",G:[["1:非通電状態の場合"]],p:"positive",k:"relation",P:"closes",J:[["2:赤弁"]],a:"2:閉じる"},O:{...neutral(),guard:{first:1,last:1},context:{first:0,last:2}},F:null,W:[0,1,2]};
  const wire={v:18,s:input.sources.map(s=>({d:s.sourceDigest,c1:[structuredClone(fact)]}))};
  return {plan,input,wire,model:sourceTaskPropositionModelSchemaFor(plan)};
}
it("binds a literal reading task to an exact action without changing the raw answer",async()=>{
  const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
  expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);
  if(r.success)expect(decodeSourcePropositions(f.plan,r.value).facts.some(f=>f.meaning.kind==="relation"&&f.meaning.predicate==="closes"&&f.meaning.guard.conditions[0]==="非通電状態の場合")).toBe(true);
  const t=propositionSourceTaskTransport(f.input);expect(t.sources[0].source.claims[0].readingTasks).toEqual([[2,"closes","positive"]]);
});
it.each(["missing_task","wrong_task","duplicate_task","wrong_predicate","wrong_clause","changed_quote","gap_proof","legacy_proof","legacy_version"])("rejects %s without fallback",async mode=>{
  const f=setup(),p=f.wire.s[0].c1[0];
  if(mode==="missing_task")p.T=[];
  if(mode==="wrong_task")p.T=[1];
  if(mode==="duplicate_task")p.T=[0,0];
  if(mode==="wrong_predicate")p.m.P="stops";
  if(mode==="wrong_clause")p.m.a="0:閉じる";
  if(mode==="changed_quote")p.m.G=[["1:通電時の場合"]];
  if(mode==="gap_proof")p.W=[0,2];
  if(mode==="legacy_proof")(p.O as Record<string,unknown>).context=[0,1,2];
  if(mode==="legacy_version")f.wire.v=17;
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("resolves repeated names only inside the declared range and exact local context",()=>{
  const c=sourceReadingClaim(1,"赤弁は、赤弁と赤弁を開く。");
  expect(resolveSourceTaskQuote(c,"0:赤弁",[0,1])).toEqual([0,2]);
  expect(()=>resolveSourceTaskQuote(c,"1:赤弁",[0,1])).toThrow();
  expect(resolveSourceTaskQuote(c,{first:1,last:1,quote:"赤弁",before:"と",after:"を"},[1])).toEqual([7,9]);
  expect(()=>resolveSourceTaskQuote(c,{first:1,last:1,quote:"赤弁",before:"は、",after:"と"},[1])).toThrow();
  expect(()=>resolveSourceTaskQuote(c,"0:赤弁",[1])).toThrow();
});
it("keeps a cross-clause OR as one unchanged quote and rejects a missing internal 前記",()=>{
  const c=sourceReadingClaim(1,"前記温度が下がった後、又は、前記圧力が下がった後に赤弁を閉じる。");
  const q={first:0,last:2,quote:"前記温度が下がった後、又は、前記圧力が下がった後",before:"",after:"に"};
  const span=resolveSourceTaskQuote(c,q,[0,1,2]);expect(c.grid.text.slice(...span)).toBe(q.quote);
  expect(()=>resolveSourceTaskQuote(c,{...q,quote:q.quote.replace("、前記圧力","、圧力")},[0,1,2])).toThrow();
  expect(()=>sourceConsecutiveIds(c,0,2,[0,2])).toThrow();
});
it("does not infer route tasks from equipment, location, capability or negative prose",()=>{
  for(const text of ["空気が流通する通路。","配管は加熱器の上流にある。","冷媒を流し、","冷媒を赤弁に流すための配管。","冷媒を赤弁に流さない。","冷媒を赤弁に流すことなく停止する。",
    "冷媒を青管から赤管に流していない。","冷媒を青管から赤管に流していなかった。","冷媒を赤弁に流しません。","冷媒を赤弁に流すことはない。","冷媒を赤弁に流入させることなく停止する。","冷媒を赤弁に流してはならない。","冷媒を赤弁に流す必要がない。"])
    expect(sourceReadingTasks(sourceReadingClaim(1,text)).filter(t=>t.kind==="path")).toEqual([]);
  const tasks=sourceReadingTasks(sourceReadingClaim(1,"冷媒を青管から赤熱交換器に流して放熱させ、白熱交換器にて吸熱させる。"));
  expect(tasks.map(t=>t.kind)).toEqual(["path","releases_heat","absorbs_heat"]);
});
it("requires a route fact in addition to both heat relations for an explicit flow task",async()=>{
  const f=setup("冷媒を青管から赤熱交換器に流して放熱させ、白熱交換器にて吸熱させる。");
  const facts=[
    {T:[0],m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"path",i:["0:青管"],j:["0:赤熱交換器"],V:[],B:[],e:"segment",r:"route"},O:neutral(),F:null,W:[0]},
    {T:[1],m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"releases_heat",J:[["0:赤熱交換器"]],a:"0:放熱させ"},O:neutral(),F:null,W:[0]},
    {T:[2],m:{u:null,x:"operation",g:"unconditional",G:[],p:"positive",k:"relation",P:"absorbs_heat",J:[["1:白熱交換器"]],a:"1:吸熱させ"},O:neutral(),F:null,W:[1]},
  ];
  const wire={v:18,s:f.input.sources.map(s=>({d:s.sourceDigest,c1:structuredClone(facts)}))};
  expect((await f.model.validate!(wire)).success).toBe(true);
  wire.s[0].c1.shift();wire.s[0].c1[0].T=[0,1];
  expect((await f.model.validate!(wire)).success).toBe(false);
});
it("does not bind an unrelated route through broad W alone",()=>{
  const c=sourceReadingClaim(1,"冷媒を青管から赤管に流し、冷媒を白管から黒管に流す。"),tasks=sourceReadingTasks(c);
  const m={k:"path",r:"route",p:"positive"},point=resolveSourceTaskQuote(c,"0:青管",[0,1]);
  expect(assertSourceTaskBindings(tasks,[0],m,[0,1],null,[point])).toEqual([0]);
  expect(()=>assertSourceTaskBindings(tasks,[0,1],m,[0,1],null,[point])).toThrow();
});
