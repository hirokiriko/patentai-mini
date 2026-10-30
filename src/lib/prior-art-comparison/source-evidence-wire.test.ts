import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { propositionSourceInput, decodeSourcePropositions } from "./proposition-extraction";
import { sourceReadingClaim } from "./source-clause-coverage";
import { SOURCE_EVIDENCE_ACTION_EXAMPLE } from "./source-clause-prompt";
import { resolveSourceEvidenceQuote, sourceClausePropositionModelSchemaFor } from "./source-clause-wire";

function setup(text=SOURCE_EVIDENCE_ACTION_EXAMPLE.clauses.map(c=>c[1]).join("")) {
  const f=fictionalInputs(), source="【請求項1】"+text;
  f.inputs.draft=parseComparisonSource(source,11,"架空");
  f.inputs.documents=f.inputs.documents.map(d=>parseComparisonSource(source,d.id,"架空"));
  const plan=makePlan(f.inputs,f.selection),input=propositionSourceInput(plan);
  return {plan,model:sourceClausePropositionModelSchemaFor(plan),wire:{v:16,s:input.sources.map(s=>({
    d:s.sourceDigest,c1:[structuredClone(SOURCE_EVIDENCE_ACTION_EXAMPLE.fact)],
  }))}};
}

it("decodes exact source roles without duplicated clause numbers and leaves raw input unchanged",async()=>{
  const f=setup(),before=JSON.stringify(f.wire),result=await f.model.validate!(f.wire);
  expect(result.success).toBe(true);
  if(result.success) {
    const decoded=decodeSourcePropositions(f.plan,result.value);
    expect(decoded.facts.some(p=>p.meaning.subject==="制御器"&&p.meaning.guard.conditions.includes("起動後の間"))).toBe(true);
  }
  expect(JSON.stringify(f.wire)).toBe(before);
});

it("limits exact occurrences to declared evidence, including disjoint and cross-clause evidence",()=>{
  const c=sourceReadingClaim(1,"赤弁を開く。青弁を閉じる。赤弁を閉じる。");
  expect(resolveSourceEvidenceQuote(c,"赤弁",[0])).toEqual([0,2]);
  expect(()=>resolveSourceEvidenceQuote(c,"赤弁",[0,2])).toThrow();
  expect(resolveSourceEvidenceQuote(c,["赤弁","","を閉じる"],[0,2])[0]).toBe(13);
  expect(()=>resolveSourceEvidenceQuote(c,"青弁",[0,2])).toThrow();
  expect(()=>resolveSourceEvidenceQuote(c,"開く。青弁",[0,2])).toThrow();
  expect(c.grid.text.slice(...resolveSourceEvidenceQuote(c,"開く。青弁",[0,1]))).toBe("開く。青弁");
  expect(()=>resolveSourceEvidenceQuote(c,"0:赤弁",[0])).toThrow();
  // Context can identify a repeated occurrence without claiming that the
  // surrounding clause is evidence for this fact.
  expect(resolveSourceEvidenceQuote(c,["赤弁","青弁を閉じる。",""],[2])[0]).toBe(13);
});

it("does not normalize Unicode or admit partial scalar boundaries",()=>{
  const c=sourceReadingClaim(1,"装置😀とe\u0301と A:B 。");
  for(const q of ["😀","e\u0301"," A:B "])expect(c.grid.text.slice(...resolveSourceEvidenceQuote(c,q,[0]))).toBe(q);
  for(const q of ["é","\ud83d","\ude00",""])expect(()=>resolveSourceEvidenceQuote(c,q,[0])).toThrow();
  expect(()=>resolveSourceEvidenceQuote(c,["とe\u0301","\ude00",""],[0])).toThrow();
});

it.each(["null_O","missing_guard","blanket_proof","wrong_W","missing_clause","legacy"])(
  "keeps fail-closed coverage and operator requirements: %s",async mode=>{
    const f=setup(mode==="missing_clause"?"制御器は、起動後の間、弁開度を大きい値に維持する。補助器を備える。":undefined);
    const fact=f.wire.s[0].c1[0] as unknown as Record<string,unknown>;
    if(mode==="null_O")fact.O=null;
    if(mode==="missing_guard")fact.O=[null,null,null,null,[0,1,2]];
    if(mode==="blanket_proof")fact.O=[null,null,null,[1],[]];
    if(mode==="wrong_W")fact.W=[1,2];
    if(mode==="legacy")f.wire.v=15;
    expect((await f.model.validate!(f.wire)).success).toBe(false);
  });

it("retains the full negative condition and rejects shortening it to the opposite state",async()=>{
  const f=setup("制御器は、非通電状態の間、弁開度を大きい値に維持する。");
  for(const s of f.wire.s)s.c1[0].m.G=[["非通電状態の間"]];
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  f.wire.s[0].c1[0].m.G=[["通電状態の間"]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});
