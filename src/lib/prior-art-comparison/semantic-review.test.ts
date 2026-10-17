import { describe, expect, it } from "vitest";
import { makePlan, SYSTEM, validateAnswer, validateSaved, savedDigest, LIMITS } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalReview, fictionalSaved } from "./fixtures.test-support";
import { batchInput, batchSchemaFor, generationBatches, requestBytes } from "./generation-batch";
import { assertReviewPlan, assertReviewSize, inspectReviewCoverage, reviewInput, reviewSchema, reviewSchemaFor, reviewTargetUnits, REVIEW_SYSTEM, validateReview } from "./semantic-review";
import { parseComparisonSource } from "./source";

function compactThree() {
  const { inputs, selection } = fictionalInputs();
  const body = "【請求項1】\n主装置は光を備え、補助装置は音又は振動を備える。\n【請求項2】\n請求項1に記載の装置であって、記録を保持する。";
  inputs.draft = parseComparisonSource(body, 11, "draft");
  inputs.documents = [21,22,23].map(id => parseComparisonSource(body, id, `架空-${id}`));
  selection.documents = inputs.documents.map(d => ({ docId:d.id, claimNos:[1], identity:{publication:d.label,edition:"架空"} }));
  return { inputs, selection };
}
function example() {
  const { inputs, selection } = compactThree();
  const plan = makePlan(inputs, selection);
  const drafts = plan.flatMap(c => validateAnswer(c, fictionalAnswer(c)).map(p => ({...p,baseObservation:"主装置は光が必須。補助装置は音又は振動。",candidateObservation:"主装置は光が必須。補助装置は音又は振動。"})));
  const input = reviewInput(plan, drafts);
  return { inputs, selection, plan, drafts, input, answer:fictionalReview(input) };
}
describe("separate original-text review before saving", () => {
  it("keeps three documents within two generation calls plus one review", () => {
    const { plan, input, answer } = example();
    const batches = generationBatches(plan, SYSTEM);
    expect(batches.map(b=>b.reduce((n,c)=>n+c.pairs.length,0))).toEqual([2,1]);
    expect(batches.flatMap(b=>b.map(c=>c.candidateId))).toEqual([21,22,23]);
    expect(input.targets).toHaveLength(15);
    expect(input.documents).toHaveLength(3);
    expect(input.scopes.map(s=>s.id)).toEqual(["base:1","candidate:21:1","candidate:22:1","candidate:23:1"]);
    expect(input.base.claims[0].text).toContain("補助装置は音又は振動");
    for (const batch of batches) expect(requestBytes(SYSTEM,JSON.stringify(batchInput(batch)),batchSchemaFor(batch))).toBeLessThan(LIMITS.inputBytes);
    expect(()=>validateReview(input, answer)).not.toThrow();
  });
  it.each(["missing","duplicate","unknown","unresolved","empty","whitespace","too_long"])("rejects %s source condition analysis even when every field is consistent",mode=>{
    const {input,answer}=example();
    if(mode==="missing") answer.sourceAnalyses.pop();
    if(mode==="duplicate") answer.sourceAnalyses[1]=answer.sourceAnalyses[0];
    if(mode==="unknown") answer.sourceAnalyses[0].id="candidate:999:1";
    if(mode==="unresolved") Object.assign(answer.sourceAnalyses[0],{status:"unresolved"});
    if(mode==="empty") answer.sourceAnalyses[0].conditions="";
    if(mode==="whitespace") answer.sourceAnalyses[0].conditions=" 　";
    if(mode==="too_long") answer.sourceAnalyses[0].conditions="漢".repeat(401);
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
  });
  it("keeps selected claims with shared ancestors as separate review scopes",()=>{
    const {inputs,selection}=compactThree();selection.documents=selection.documents.slice(0,2);
    selection.documents.forEach(d=>d.claimNos=[1,2]);
    const plan=makePlan(inputs,selection);
    const drafts=plan.flatMap(c=>validateAnswer(c,fictionalAnswer(c)).map(p=>({...p,baseObservation:"基準",candidateObservation:"候補"})));
    const input=reviewInput(plan,drafts);
    expect(input.scopes.map(s=>s.id)).toEqual(["base:1","candidate:21:1","candidate:21:2","candidate:22:1","candidate:22:2"]);
    expect(input.scopes.find(s=>s.id==="candidate:21:2")?.contextClaimNos).toEqual([1,2]);
    expect(()=>validateReview(input,fictionalReview(input))).not.toThrow();
  });
  it.each(["failed","uncertain","missing","duplicate","unknown","wrong_digest","wrong_scope","wrong_side","empty_support","empty_reason","modified_result"])("rejects %s review", mode=>{
    const {input,answer}=example();
    if(mode==="failed" || mode==="uncertain") Object.assign(answer.checks.at(-1)!,{verdict:mode==="failed"?"inconsistent":"uncertain"});
    if(mode==="missing") answer.checks.pop();
    if(mode==="duplicate") answer.checks[1]=answer.checks[0];
    if(mode==="unknown") answer.checks[0].id="unknown";
    if(mode==="wrong_digest") answer.draftDigest="f".repeat(64);
    if(mode==="wrong_scope") answer.checks[0].baseClaimNos=[2];
    if(mode==="wrong_side") answer.checks[0].candidateClaimNos=[1];
    if(mode==="empty_support") answer.checks[2].candidateClaimNos=[];
    if(mode==="empty_reason") answer.checks[0].reason=" 　";
    if(mode==="modified_result") Object.assign(answer,{correctedResult:"silently changed"});
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
  });
  it("binds all five exact fields to the reviewed draft and preserves distinct subjects",()=>{
    const {plan,drafts,input,answer}=example();
    drafts[0].common="主装置又は補助装置は光・音・振動のいずれかを備える。"; // False regrouping.
    const changed=reviewInput(plan,drafts);
    expect(changed.targets[2].text).toBe(drafts[0].common);
    expect(changed.draftDigest).not.toBe(input.draftDigest);
    expect(()=>validateReview(changed,answer)).toThrow("ai_incomplete");
    const failed=fictionalReview(changed);Object.assign(failed.checks[2],{verdict:"inconsistent",reason:"別主語の必須条件と択一条件を混同。"});
    expect(()=>validateReview(changed,failed)).toThrow("ai_incomplete");
    // A fixture proves the gate, not whether a real model detects this error.
  });
  it("requires an exact rejected assertion while still refusing a negative review for saving", () => {
    const { input, answer } = example(), target = input.targets[2];
    const rejected = { ...answer, checks: answer.checks.map((check, i) => i !== 2 ? check : {
      ...check, verdict: "inconsistent", reason: "架空の対象関係が原文と矛盾。",
      unitChecks: check.unitChecks.map(unit => ({ ...unit, verdict: "inconsistent" })),
      rejectedTargetSpan: { start: 0, end: target.text.length, quote: target.text },
    }) };
    expect(inspectReviewCoverage(input, rejected).checks[2].verdict).toBe("inconsistent");
    expect(() => validateReview(input, rejected)).toThrow("ai_incomplete");
  });
  it.each(["missing", "foreign", "offset", "empty", "past_end", "consistent", "uncertain"])("rejects %s problem spans", mode => {
    const { input, answer } = example(), target = input.targets[2];
    const bad = { ...answer, checks: answer.checks.map((check, i) => i !== 2 ? check : {
      ...check, verdict: mode === "consistent" ? "consistent" : mode === "uncertain" ? "uncertain" : "inconsistent",
      unitChecks: check.unitChecks.map(unit => ({ ...unit, verdict: mode === "consistent" ? "consistent" : mode === "uncertain" ? "uncertain" : "inconsistent" })),
      rejectedTargetSpan: { start: 0, end: target.text.length, quote: target.text },
    }) };
    if (mode === "missing") Object.assign(bad.checks[2], { rejectedTargetSpan: null });
    if (mode === "foreign") bad.checks[2].rejectedTargetSpan!.quote = "草稿に存在しない断定";
    if (mode === "offset") bad.checks[2].rejectedTargetSpan!.start = 1;
    if (mode === "empty") Object.assign(bad.checks[2].rejectedTargetSpan!, { end: 0, quote: "" });
    if (mode === "past_end") bad.checks[2].rejectedTargetSpan!.end++;
    expect(() => inspectReviewCoverage(input, bad)).toThrow("ai_incomplete");
  });
  it("requires a visible whole-character problem span in UTF-16 coordinates", () => {
    const { plan, drafts } = example(); drafts[0].common = "𠮷の表示は青色。　";
    const input = reviewInput(plan, drafts), answer = fictionalReview(input), target = answer.checks[2];
    Object.assign(target, { verdict: "inconsistent", rejectedTargetSpan: { start: 0, end: 2, quote: "𠮷" } });
    Object.assign(target.unitChecks[0], { verdict: "inconsistent" });
    expect(() => inspectReviewCoverage(input, answer)).not.toThrow();
    target.rejectedTargetSpan = { start: 0, end: 1, quote: "\ud842" };
    expect(() => inspectReviewCoverage(input, answer)).toThrow("ai_incomplete");
    target.rejectedTargetSpan = { start: drafts[0].common.length - 1, end: drafts[0].common.length, quote: "　" };
    expect(() => inspectReviewCoverage(input, answer)).toThrow("ai_incomplete");
  });
  it("preflights maximum draft sizes and the complete original before sending",()=>{
    const {plan,input}=example();
    expect(()=>assertReviewPlan(plan)).not.toThrow();
    for(const target of input.targets) target.text="\\".repeat(200);
    expect(()=>assertReviewSize(input)).not.toThrow();
    input.base={...input.base,claims:[{...input.base.claims[0],text:"大".repeat(30000)}]};
    expect(()=>assertReviewSize(input)).toThrow("plan_limit");
  });
  it("reserves lone-surrogate escaping before any draft is generated",()=>{
    const {plan,drafts}=example();
    const envelope=(character:string)=>drafts.map(d=>({...d,baseObservation:character.repeat(120),candidateObservation:character.repeat(120),common:character.repeat(200),differences:character.repeat(200),unconfirmed:character.repeat(120),
      baseEvidence:{claimNo:Number.MAX_SAFE_INTEGER,start:Number.MAX_SAFE_INTEGER,end:Number.MAX_SAFE_INTEGER,quote:character.repeat(120)},
      candidateEvidence:{claimNo:Number.MAX_SAFE_INTEGER,start:Number.MAX_SAFE_INTEGER,end:Number.MAX_SAFE_INTEGER,quote:character.repeat(120)}}));
    const slash=reviewInput(plan,envelope("\\"));
    const spare=LIMITS.inputBytes-requestBytes(REVIEW_SYSTEM,JSON.stringify(slash),reviewSchemaFor(slash));
    expect(spare).toBeGreaterThan(0);
    const padded=plan.map(c=>({...c,base:{...c.base,claims:c.base.claims.map((claim,i)=>i?claim:{...claim,text:claim.text+"X".repeat(spare)})}}));
    expect(()=>assertReviewSize(reviewInput(padded,envelope("\\")))).not.toThrow();
    expect(()=>assertReviewSize(reviewInput(padded,envelope("\ud800")))).toThrow("plan_limit");
    expect(()=>assertReviewPlan(padded)).toThrow("plan_limit");
  });
  it("rejects new six-pair runs but still reads old six-pair snapshots",()=>{
    const {inputs,selection}=compactThree();selection.documents.forEach(d=>d.claimNos=[1,2]);
    expect(()=>makePlan(inputs,selection)).toThrow("plan_limit");
    const saved=fictionalSaved();Object.assign(saved,{inputs,selection,operationId:selection.operationId});
    saved.pairs=inputs.documents.flatMap(d=>[1,2].map(no=>({docId:d.id,baseClaimNo:1,candidateClaimNo:no,common:"原文範囲を比較。",differences:"対応は要確認。",unconfirmed:"図面は未確認。",
      baseEvidence:{claimNo:1,quote:inputs.draft.source.claims[0].text,start:0,end:inputs.draft.source.claims[0].text.length},
      candidateEvidence:{claimNo:no,quote:d.source.claims[no-1].text,start:0,end:d.source.claims[no-1].text.length}})));
    saved.snapshotDigest=savedDigest(saved);
    expect(validateSaved(saved).pairs).toHaveLength(6);
  });
  it("bounds source analyses and twenty assessments without treating text length as a token guarantee",()=>{
    const ids=Array.from({length:4},(_,i)=>["baseObservation","candidateObservation","common","differences","unconfirmed"].map(field=>`${Number.MAX_SAFE_INTEGER-i}:1000:1000:${field}`)).flat();
    const sourceAnalyses=Array.from({length:8},(_,i)=>({id:`base:${i+1}`,conditions:"漢".repeat(400),status:"resolved"}));
    const answer=reviewSchema.parse({draftDigest:"a".repeat(64),sourceAnalyses,checks:ids.map(id=>({id,reason:"漢".repeat(40),baseClaimNos:[998,999,1000],candidateClaimNos:[998,999,1000],unitChecks:[{start:0,targetReading:"漢".repeat(60),sourceComparison:"漢".repeat(80),verdict:"inconsistent"}],verdict:"inconsistent",rejectedTargetSpan:{start:0,end:120,quote:"漢".repeat(120)}}))});
    expect(answer.sourceAnalyses).toHaveLength(8);
    expect(answer.checks).toHaveLength(20);
    expect(()=>reviewSchema.parse({...answer,sourceAnalyses:[...sourceAnalyses,sourceAnalyses[0]]})).toThrow();
    const {input}=example();expect(requestBytes(REVIEW_SYSTEM,JSON.stringify(input),reviewSchemaFor(input))).toBeLessThan(LIMITS.inputBytes);
  });
  it("partitions complete fields without changing text, punctuation or UTF-16 coordinates", () => {
    for (const text of ["基準は光が必須。候補は音又は振動。", "𠮷は青色。　次は赤色。　", "一文だけ", "句点の列。。次の文。", "。".repeat(200)]) {
      const units = reviewTargetUnits(text);
      expect(units.map(unit => unit.text).join("")).toBe(text);
      expect(units[0].start).toBe(0);
      expect(units.at(-1)!.end).toBe(text.length);
      for (const unit of units) expect(text.slice(unit.start, unit.end)).toBe(unit.text);
    }
  });
  it.each(["missing", "duplicate", "foreign", "blank_reading", "blank_comparison", "contradiction", "uncertain", "wrong_span_unit", "tampered_boundaries"])("refuses %s sentence review even if the field says consistent", mode => {
    const { plan, drafts } = example();
    drafts[0].differences = "主装置又は補助装置は光を備える。候補は音又は振動を備える。";
    const input = reviewInput(plan, drafts), answer = fictionalReview(input), check = answer.checks[3];
    expect(check.unitChecks).toHaveLength(2);
    if (mode === "missing") check.unitChecks.shift();
    if (mode === "duplicate") check.unitChecks[1] = check.unitChecks[0];
    if (mode === "foreign") check.unitChecks[0].start = 1;
    if (mode === "blank_reading") check.unitChecks[0].targetReading = "　";
    if (mode === "blank_comparison") check.unitChecks[0].sourceComparison = " ";
    if (mode === "contradiction" || mode === "uncertain") Object.assign(check.unitChecks[0], { verdict: mode === "contradiction" ? "inconsistent" : "uncertain" });
    if (mode === "wrong_span_unit") {
      Object.assign(check, { verdict: "inconsistent", rejectedTargetSpan: { start: check.unitChecks[1].start, end: drafts[0].differences.length, quote: reviewTargetUnits(drafts[0].differences)[1].text } });
      Object.assign(check.unitChecks[0], { verdict: "inconsistent" });
    }
    if (mode === "tampered_boundaries") input.targets[3].unitStarts = [0];
    expect(() => inspectReviewCoverage(input, answer)).toThrow("ai_incomplete");
  });
  it("aggregates a rejected first sentence before an otherwise supported second sentence", () => {
    const { plan, drafts } = example(); drafts[0].differences = "主装置又は補助装置は光を備える。候補は音又は振動を備える。";
    const input = reviewInput(plan, drafts), answer = fictionalReview(input), check = answer.checks[3], first = reviewTargetUnits(drafts[0].differences)[0];
    Object.assign(check.unitChecks[0], { verdict: "inconsistent", targetReading: "主装置と補助装置を一群として光を選択。", sourceComparison: "原文は主装置の光が必須。補助装置の音/振動とは別対象。" });
    Object.assign(check, { verdict: "inconsistent", rejectedTargetSpan: { start: first.start, end: first.end, quote: first.text } });
    expect(inspectReviewCoverage(input, answer).checks[3].unitChecks[1].verdict).toBe("consistent");
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
  });
  it("keeps the lone-surrogate envelope above punctuation-heavy unit-boundary wire costs", () => {
    const { plan, drafts } = example();
    const size = (text: string) => { const input = reviewInput(plan, drafts.map(d => ({ ...d, common: text, differences: text }))); return requestBytes(REVIEW_SYSTEM, JSON.stringify(input), reviewSchemaFor(input)); };
    const worst = size("\ud800".repeat(200));
    for (const text of ["あ。".repeat(100), "\ud800。".repeat(100), "。x".repeat(100), "a。".repeat(100), "。".repeat(200)]) expect(size(text)).toBeLessThanOrEqual(worst);
  });
});
