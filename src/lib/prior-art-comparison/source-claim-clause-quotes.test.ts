import{describe,it,expect}from "vitest";
import{sourceReadingClaim}from "./source-clause-coverage";
import{decodeClaimClauseQuotes}from "./source-claim-clause-quotes";
import{resolveSourceOrderedQuote}from "./source-reading-tasks";
const q=(quote:string,clause:number,id="q0")=>({id,quote,clause});
describe("explicit-clause exact original quote transport",()=>{
 it("selects distinct same-word occurrences by their explicit start clause without changing raw",()=>{
  const c=sourceReadingClaim(1,"白管と黒管を備え、白管から黒管へ流す。"),raw=[q("白管",0),q("白管",1,"q1")],before=JSON.stringify(raw);
  const decoded=decodeClaimClauseQuotes(c,raw)as {id:string;first:number;last:number;quote:string;before:string;after:string}[];
  expect(decoded.map(({id,...quote})=>({id,span:resolveSourceOrderedQuote(c,quote,[quote.first])}))).toEqual([{id:"q0",span:[0,2]},{id:"q1",span:[9,11]}]);expect(JSON.stringify(raw)).toBe(before);
 });
 it("rejects two matches starting in the same clause; explicit longer original quote may distinguish",()=>{
  const c=sourceReadingClaim(1,"甲赤弁乙赤弁丙。");expect(()=>decodeClaimClauseQuotes(c,[q("赤弁",0)])).toThrow();expect(decodeClaimClauseQuotes(c,[q("乙赤弁",0)])).toHaveLength(1);
 });
 it("requires the declared start clause and permits an exact quote crossing original clauses",()=>{
  const c=sourceReadingClaim(1,"甲から、乙に流す。");expect(decodeClaimClauseQuotes(c,[q("から、乙",0)])).toHaveLength(1);expect(()=>decodeClaimClauseQuotes(c,[q("から、乙",1)])).toThrow();
 });
 it.each([-1,0.5,99,NaN,Infinity])("rejects invalid clause %s",clause=>{expect(()=>decodeClaimClauseQuotes(sourceReadingClaim(1,"甲。"),[q("甲",clause)])).toThrow();});
 it.each(["前記甲","乙","甲 ","甲。別請求項"])('rejects nonliteral or foreign claim quote %s',quote=>{expect(()=>decodeClaimClauseQuotes(sourceReadingClaim(1,"甲。"),[q(quote,0)])).toThrow();});
 it("rejects legacy context/coordinate fields and missing explicit clause",()=>{
  const c=sourceReadingClaim(1,"甲。");for(const v of [{id:"q0",quote:"甲",before:"",after:""},{...q("甲",0),before:""},{id:"q0",K:[0,0,0,0]}])expect(()=>decodeClaimClauseQuotes(c,[v])).toThrow();
 });
 it("rejects duplicate IDs and duplicate selected spans",()=>{
  const c=sourceReadingClaim(1,"甲、乙。");expect(()=>decodeClaimClauseQuotes(c,[q("甲",0),q("乙",1)])).toThrow();expect(()=>decodeClaimClauseQuotes(c,[q("甲",0),q("甲",0,"q1")])).toThrow();
 });
 it("keeps Unicode scalar boundaries and rejects normalization",()=>{
  const c=sourceReadingClaim(1,"甲😀e\u0301乙。");expect(decodeClaimClauseQuotes(c,[q("😀",0)])).toHaveLength(1);expect(()=>decodeClaimClauseQuotes(c,[q("\ud83d",0)])).toThrow();expect(()=>decodeClaimClauseQuotes(c,[q("é",0)])).toThrow();
 });
 it("preserves the12 consecutive clause cap",()=>{
  const c=sourceReadingClaim(1,Array.from({length:13},(_,i)=>String.fromCharCode(0x4e00+i)+"、").join(''));
  expect(decodeClaimClauseQuotes(c,[q(c.grid.text.slice(...[0,c.clauses[11][1]]as [number,number]),0)])).toHaveLength(1);expect(()=>decodeClaimClauseQuotes(c,[q(c.grid.text,0)])).toThrow();
 });
 it.each(['q0a','q10000','Q1','q-1'])('retains digit-only IDs %s',id=>{expect(()=>decodeClaimClauseQuotes(sourceReadingClaim(1,"甲。"),[q("甲",0,id)])).toThrow();});
});
