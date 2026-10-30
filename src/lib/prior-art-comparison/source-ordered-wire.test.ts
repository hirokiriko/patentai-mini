import {expect,it} from "vitest";
import {fictionalInputs} from "./fixtures.test-support";
import {makePlan} from "./comparison";
import {parseComparisonSource} from "./source";
import {decodeSourcePropositions,propositionSourceInput} from "./proposition-extraction";
import {sourceOrderedPropositionModelSchemaFor,propositionSourceOrderedTransport,sourceCitedPropositionModelSchemaFor} from "./source-semantic-wire";
import {sourceOrderedQuote,sourceOrderedFactRows,sourceDeclaredOrderedEvidence,resolveSourceOrderedQuote} from "./source-reading-tasks";
import {sourceReadingClaim} from "./source-clause-coverage";
const neutral=()=>({selection:null,extent:null,polarity:null,guard:null,context:null});
const close=()=>({m:{u:["0-0:制御器"],x:"operation",g:"when",G:[["1-1:非通電状態の場合"]],p:"positive",k:"relation",P:"closes",J:[["2-2:赤弁"]],a:"2-2:閉じる"},O:{...neutral(),guard:"1-1:非通電状態の場合",context:"0-2:制御器は、非通電状態の場合、赤弁を閉じる。"},F:null});
function setup(){const f=fictionalInputs(),text="【請求項1】制御器は、非通電状態の場合、赤弁を閉じる。";
 f.inputs.draft=parseComparisonSource(text,11,"架空");f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(text,d.id,"架空"));
 const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
 return {plan,input,model:sourceOrderedPropositionModelSchemaFor(plan),wire:{v:20,s:input.sources.map(s=>({d:s.sourceDigest,c1:[[],[],[close()]]}))}};}
it("reads ordered original rows, preserves supplied meanings and leaves raw unchanged",async()=>{
 const f=setup(),before=JSON.stringify(f.wire),r=await f.model.validate!(f.wire);
 expect(r.success).toBe(true);expect(JSON.stringify(f.wire)).toBe(before);
 if(r.success)expect(decodeSourcePropositions(f.plan,r.value).facts.some(p=>p.meaning.kind==="relation"&&p.meaning.predicate==="closes")).toBe(true);
 expect(propositionSourceOrderedTransport(f.input).citationClauses.version).toBe(5);
});
it.each(["missing_row","extra_row","flat_facts","operator_only_anchor","bare_operator","old_short_quote","wrong_range","changed_quote","legacy_version","W","T"])("rejects %s without repair",async mode=>{
 const f=setup(),p=f.wire.s[0].c1[2][0] as ReturnType<typeof close>&Record<string,unknown>;
 if(mode==="missing_row")f.wire.s[0].c1.pop();if(mode==="extra_row")f.wire.s[0].c1.push([]);
 if(mode==="flat_facts")(f.wire.s[0] as unknown as {c1:unknown}).c1=[p];
 if(mode==="operator_only_anchor"){p.m.u=[];p.m.G=[];p.m.J=[["2-2:赤弁"]];f.wire.s[0].c1=[[p],[],[]];}
 if(mode==="bare_operator")(p.O as Record<string,unknown>).guard={first:1,last:1};
 if(mode==="old_short_quote")p.m.a="2:閉じる";if(mode==="wrong_range")p.m.a="0-0:閉じる";
 if(mode==="changed_quote")p.m.G=[["1-1:通電時の場合"]];if(mode==="legacy_version")f.wire.v=19;
 if(mode==="W")p.W=[0,1,2];if(mode==="T")p.T=[0];
 expect((await f.model.validate!(f.wire)).success).toBe(false);
});
it("resolves only declared consecutive ranges, with exact context for ambiguity and Unicode",()=>{
 const c=sourceReadingClaim(1,"😀赤弁は、赤弁と赤弁を開く。");
 expect(resolveSourceOrderedQuote(c,"0-0:😀赤弁",[0,1])).toEqual([0,4]);
 expect(()=>resolveSourceOrderedQuote(c,"1-1:赤弁",[0,1])).toThrow();
 expect(resolveSourceOrderedQuote(c,{first:1,last:1,quote:"赤弁",before:"と",after:"を"},[1])).toEqual([9,11]);
 expect(()=>resolveSourceOrderedQuote(c,"1-1:😀赤弁",[0,1])).toThrow();
 expect(()=>resolveSourceOrderedQuote(c,"1-0:赤弁",[0,1])).toThrow();
 expect(()=>sourceOrderedQuote("1:赤弁")).toThrow();
});
it("keeps cross-clause exact maintained state and OR quotes explicit",()=>{
 const c=sourceReadingClaim(1,"温度が下がった後、又は、圧力が下がった後に赤弁が閉じ、青弁が開いた状態を維持する。");
 const q="0-2:温度が下がった後、又は、圧力が下がった後";
 expect(c.grid.text.slice(...resolveSourceOrderedQuote(c,q,c.clauses.map((_,i)=>i)))).toBe(q.split(":")[1]);
 expect(()=>resolveSourceOrderedQuote(c,"0-0:"+q.split(":")[1],c.clauses.map((_,i)=>i))).toThrow();
});
it("keeps twelve-clause evidence bound and never edits explicit operator words",()=>{
 const c=sourceReadingClaim(1,Array.from({length:14},(_,i)=>`部品${i}。`).join(""));
 const f={m:{u:null,G:[],J:[["0-0:部品0"]]},O:{...neutral(),context:"0-12:"+c.grid.text.split("。").slice(0,13).join("。")+"。"},F:null};
 expect(()=>sourceDeclaredOrderedEvidence(c,f)).toThrow();
 expect(()=>sourceOrderedFactRows(c,Array.from({length:14},(_,i)=>i===13?[f]:[]))).toThrow();
});
it("does not make old v19 raw responses acceptable as v20",async()=>{
 const f=setup();const old={v:19,s:f.input.sources.map(s=>({d:s.sourceDigest,c1:[{m:{...close().m,u:["0:制御器"],G:[["1:非通電状態の場合"]],J:[["2:赤弁"]],a:"2:閉じる"},O:{...neutral(),guard:{first:1,last:1},context:{first:0,last:2}},F:null}]}))};
 expect((await sourceCitedPropositionModelSchemaFor(f.plan).validate!(old)).success).toBe(true);
 expect((await f.model.validate!(old)).success).toBe(false);
});

it("never credits an operator or broad declared range as the row's own meaning quote",()=>{
 const c=sourceReadingClaim(1,"制御器は、非通電状態の場合、赤弁を閉じる。"),f={m:{J:[["0-2:赤弁"]]},O:{...neutral(),context:"0-2:"+c.grid.text},F:null};
 expect(()=>sourceOrderedFactRows(c,[[f],[],[]])).toThrow();
 expect(sourceOrderedFactRows(c,[[],[],[f]])).toEqual([f]);
});
