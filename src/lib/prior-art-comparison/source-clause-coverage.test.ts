import {expect,it} from "vitest";
import {sourceReadingClaim,sourceReadingClauses,sourceFactEvidence,assertSourceClauseCoverage} from "./source-clause-coverage";
import {sourceCellRef} from "./source-citation-grid";
it("partitions punctuation while preserving leading spaces, newlines and every character",()=>{
  const text="\n\n 装置は弁を備え、\n弁を開く。  \n";
  const spans=sourceReadingClauses(text);
  expect(spans.map(s=>text.slice(...s)).join("")).toBe(text);
  expect(spans[0][0]).toBe(0);expect(spans.at(-1)![1]).toBe(text.length);
});
function fixture(){
  const claim=sourceReadingClaim(1,"装置は弁を備える。弁を開く。"),a=claim.clauses[0],b=claim.clauses[1];
  const facts=new Map([["c1:0",{claimNo:1,evidence:[a]}],["c1:1",{claimNo:1,evidence:[b]}]]);
  return {claim,facts,rows:[["c1:0"],["c1:1"]]};
}
it("requires each clause and fact without promoting declared reading to semantic proof",()=>{
  const f=fixture();expect(()=>assertSourceClauseCoverage([f.claim],f.facts,f.rows)).not.toThrow();
  f.facts.delete("c1:1");f.rows[1]=["?Valve timing is not represented in this fixture"];
  expect(()=>assertSourceClauseCoverage([f.claim],f.facts,f.rows)).not.toThrow();
});
it.each(["missing_row","extra_row","empty_row","reordered","foreign_fact","foreign_claim","unused_fact","empty_reason","duplicate"])("rejects incomplete reading bookkeeping %s",mode=>{
  const f=fixture();
  if(mode==="missing_row")f.rows.pop();
  if(mode==="extra_row")f.rows.push(["?extra"]);
  if(mode==="empty_row")f.rows[0]=[];
  if(mode==="reordered")f.rows.reverse();
  if(mode==="foreign_fact")f.rows[0]=["c1:2"];
  if(mode==="foreign_claim")f.facts.get("c1:0")!.claimNo=2;
  if(mode==="unused_fact")f.rows[0]=["?unrepresented"];
  if(mode==="empty_reason")f.rows[0]=["?  "];
  if(mode==="duplicate")f.rows[0].push("c1:0");
  expect(()=>assertSourceClauseCoverage([f.claim],f.facts,f.rows)).toThrow("comparison_source_coverage_invalid");
});
it("rejects full multi-clause basis as a substitute for independently selected evidence",()=>{
  const {claim}=fixture(),whole=sourceCellRef(claim.grid,[0,claim.grid.text.length]);
  expect(()=>sourceFactEvidence(claim,[whole])).toThrow();
  expect(()=>sourceFactEvidence(claim,[])).toThrow();
  expect(()=>sourceFactEvidence(claim,[[],whole])).toThrow();
  const single=sourceReadingClaim(1,"弁を開く。");
  expect(sourceFactEvidence(single,[sourceCellRef(single.grid,[0,single.grid.text.length])])).toEqual([[0,single.grid.text.length]]);
});
