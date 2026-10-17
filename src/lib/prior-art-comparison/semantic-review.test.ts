import { describe, expect, it } from "vitest";
import { makePlan, SYSTEM, validateAnswer, validateSaved, savedDigest, LIMITS } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalReview, fictionalSaved } from "./fixtures.test-support";
import { batchInput, batchSchemaFor, generationBatches, requestBytes } from "./generation-batch";
import { assertReviewPlan, assertReviewSize, inspectReviewCoverage, resolveReviewAnchor, reviewInput, reviewSchema, reviewSchemaFor, reviewTargetUnits, REVIEW_SYSTEM, validateReview } from "./semantic-review";
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

describe("complete original-text contrast review before saving", () => {
  it("keeps complete sources and every exact field within two generation calls plus one review", () => {
    const { plan, input, answer } = example();
    const batches = generationBatches(plan, SYSTEM);
    expect(batches.map(b=>b.reduce((n,c)=>n+c.pairs.length,0))).toEqual([3]);
    expect(input.targets).toHaveLength(15);
    expect(input.scopes.map(s=>s.id)).toEqual(["base:1","candidate:21:1","candidate:22:1","candidate:23:1"]);
    for (const batch of batches) expect(requestBytes(SYSTEM,JSON.stringify(batchInput(batch)),batchSchemaFor(batch))).toBeLessThan(LIMITS.inputBytes);
    expect(()=>validateReview(input, answer)).not.toThrow();
    for (const source of [input.base, ...input.documents.map(d=>d.source)]) {
      const original = source === input.base ? plan[0].base : plan.find(c=>c.candidate.publicationNumber===source.publicationNumber)!.candidate;
      expect(source.version).toBe(original.version);
      for (const claim of source.claims) expect(claim.segments.map(([,text])=>text).join("")).toBe(original.claims.find(c=>c.claimNo===claim.claimNo)!.text);
    }
  });
  it("keeps selected claims with shared ancestors as separate scopes and derives all actual support numbers",()=>{
    const {inputs,selection}=compactThree(); selection.documents=selection.documents.slice(0,2);
    selection.documents.forEach(d=>d.claimNos=[1,2]);
    const plan=makePlan(inputs,selection), drafts=plan.flatMap(c=>validateAnswer(c,fictionalAnswer(c)).map(p=>({...p,baseObservation:"基準",candidateObservation:"候補"})));
    const input=reviewInput(plan,drafts), answer=fictionalReview(input);
    expect(input.scopes.map(s=>s.id)).toEqual(["base:1","candidate:21:1","candidate:21:2","candidate:22:1","candidate:22:2"]);
    const check=answer.checks.find(c=>c.id==="21:1:2:common")!;
    check.unitChecks[0].evidenceIds=[input.base.claims[0].segments[0][0],...input.documents[0].source.claims.flatMap(c=>c.segments.map(([id])=>id))];
    expect(inspectReviewCoverage(input,answer).checks.find(c=>c.id===check.id)?.candidateClaimNos).toEqual([1,2]);
    expect(()=>validateReview(input,answer)).not.toThrow();
  });
  it.each(["sourceFacts","sourceAnalyses","correctedResult"])("strictly refuses removed root field %s",key=>{
    const {input,answer}=example(); Object.assign(answer,{[key]:[]});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each(["verdict","reason","baseClaimNos","candidateClaimNos","rejectedTargetAnchor"])("strictly refuses removed check field %s",key=>{
    const {input,answer}=example(); Object.assign(answer.checks[0],{[key]:null});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("rejects old unit readings, full old replies and derived reports as new raw wire",()=>{
    const {input,answer}=example();
    const derived=inspectReviewCoverage(input,answer);
    expect(()=>inspectReviewCoverage(input,derived)).toThrow("ai_incomplete");
    const old={draftDigest:input.draftDigest,sourceFacts:[],sourceAnalyses:[],checks:[{id:input.targets[0].id,verdict:"consistent",unitChecks:[{start:0,targetReading:{statement:"旧要約"},sourceComparison:"旧対比",verdict:"consistent"}]}]};
    expect(()=>inspectReviewCoverage(input,old)).toThrow("ai_incomplete");
    Object.assign(answer.checks[0].unitChecks[0],{targetReading:{statement:"旧要約"}});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each(["missing","duplicate","foreign","wrong_digest","missing_unit","duplicate_unit","foreign_start","boundaries","blank","control"])("refuses %s coverage",mode=>{
    const {input,answer}=example(), check=answer.checks[0];
    if(mode==="missing")answer.checks.pop();
    if(mode==="duplicate")answer.checks[1]=check;
    if(mode==="foreign")check.id="999:1:1:common";
    if(mode==="wrong_digest")answer.draftDigest="f".repeat(64);
    if(mode==="missing_unit")check.unitChecks.pop();
    if(mode==="duplicate_unit")check.unitChecks[1]=check.unitChecks[0];
    if(mode==="foreign_start")check.unitChecks[0].start=1;
    if(mode==="boundaries")input.targets[0].unitStarts=[0];
    if(mode==="blank")check.unitChecks[0].sourceComparison="　 ";
    if(mode==="control")check.unitChecks[0].sourceComparison="対比\n未完";
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each(["unknown","duplicate","wrong_side","wrong_document","outside_closure","blank_segment","missing_base","missing_candidate"])("refuses %s evidence for C/I and never silently fills support",mode=>{
    for(const verdict of ["consistent","inconsistent"] as const){
      const {input,answer}=example(), at=mode==="missing_base"||mode==="missing_candidate"?2:mode==="wrong_document"?1:0, unit=answer.checks[at].unitChecks[0];
      unit.verdict=verdict; if(verdict==="inconsistent")unit.rejectedTargetAnchor=reviewTargetUnits(input.targets[at].text)[0].text;
      if(mode==="unknown")unit.evidenceIds=["b:999:0"];
      if(mode==="duplicate")unit.evidenceIds.push(unit.evidenceIds[0]);
      if(mode==="wrong_side")unit.evidenceIds=[input.documents[0].source.claims[0].segments[0][0]];
      if(mode==="wrong_document")unit.evidenceIds=[input.documents[1].source.claims[0].segments[0][0]];
      if(mode==="outside_closure"){input.base.claims.push({...input.base.claims[0],claimNo:2,segments:[["b:2:0","閉包外の原文。"]]});unit.evidenceIds=["b:2:0"];}
      if(mode==="blank_segment"){input.base.claims[0].segments.push(["b:1:999","　 "]);unit.evidenceIds=["b:1:999"];}
      if(mode==="missing_base")unit.evidenceIds=unit.evidenceIds.filter(id=>!id.startsWith("b:"));
      if(mode==="missing_candidate")unit.evidenceIds=unit.evidenceIds.filter(id=>id.startsWith("b:"));
      expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    }
  });
  it("allows unresolved proof only as U, refuses invalid U references, and never saves U",()=>{
    const {input,answer}=example(), unit=answer.checks[2].unitChecks[0];
    Object.assign(unit,{verdict:"uncertain",evidenceIds:[],sourceComparison:"必要な参照枝の解釈を解決できない。"});
    expect(inspectReviewCoverage(input,answer).checks[2].verdict).toBe("uncertain");
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    for(const ids of [["unknown"],["b:1:0","b:1:0"],[input.documents[1].source.claims[0].segments[0][0]]]){
      unit.evidenceIds=ids;expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    }
  });
  it.each(["consistent","inconsistent"] as const)("accepts %s contrast with each side grounded in its own sentence",verdict=>{
    const {plan,drafts}=example();drafts[0].differences="基準側は光を必須とする。候補側は音又は振動を備える。";
    const input=reviewInput(plan,drafts),answer=fictionalReview(input),check=answer.checks[3],units=reviewTargetUnits(input.targets[3].text);
    check.unitChecks[0].evidenceIds=[input.base.claims[0].segments[0][0]];
    check.unitChecks[1].evidenceIds=[input.documents[0].source.claims[0].segments[0][0]];
    Object.assign(check.unitChecks[0],{verdict,rejectedTargetAnchor:verdict==="inconsistent"?units[0].text:null});
    expect(inspectReviewCoverage(input,answer).checks[3].verdict).toBe(verdict);
    if(verdict==="consistent")expect(()=>validateReview(input,answer)).not.toThrow();else expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    check.unitChecks[1].evidenceIds=[input.base.claims[0].segments[0][0]];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("retains complete contrast longer than the old 80-character cap",()=>{
    const {input,answer}=example(), text="原文の対象、条件、経路を当該文の全断定と対比する。".repeat(20);
    answer.checks[2].unitChecks[0].sourceComparison=text;
    expect(inspectReviewCoverage(input,answer).checks[2].unitChecks[0].sourceComparison).toBe(text);
    expect(()=>validateReview(input,answer)).not.toThrow();
  });
  it("aggregates I before U before C in source order, while validating raw negative reports",()=>{
    const {input,answer}=example(), check=answer.checks[0], units=reviewTargetUnits(input.targets[0].text);
    Object.assign(check.unitChecks[0],{verdict:"uncertain",evidenceIds:[]});
    Object.assign(check.unitChecks[1],{verdict:"inconsistent",rejectedTargetAnchor:units[1].text});
    check.unitChecks.reverse();
    expect(inspectReviewCoverage(input,answer).checks[0]).toMatchObject({verdict:"inconsistent",rejectedTargetAnchor:{unitStart:units[1].start,quote:units[1].text}});
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    Object.assign(check.unitChecks[1],{verdict:"inconsistent",evidenceIds:[input.base.claims[0].segments[0][0]],rejectedTargetAnchor:units[0].text});
    expect(inspectReviewCoverage(input,answer).checks[0].rejectedTargetAnchor?.unitStart).toBe(0);
  });
  it.each(["missing","empty","foreign","other_unit","long","consistent","uncertain"])("refuses %s negative anchor",mode=>{
    const {input,answer}=example(), unit=answer.checks[0].unitChecks[0];
    Object.assign(unit,{verdict:"inconsistent",rejectedTargetAnchor:reviewTargetUnits(input.targets[0].text)[0].text});
    if(mode==="missing")unit.rejectedTargetAnchor=null;
    if(mode==="empty")unit.rejectedTargetAnchor="　";
    if(mode==="foreign")unit.rejectedTargetAnchor="当該文にない断定";
    if(mode==="other_unit")unit.rejectedTargetAnchor=reviewTargetUnits(input.targets[0].text)[1].text;
    if(mode==="long")unit.rejectedTargetAnchor="漢".repeat(121);
    if(mode==="consistent"||mode==="uncertain")unit.verdict=mode;
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each([
    ["同じ語同じ語。",{unitStart:0,quote:"同じ語"}], ["第一文。第二文。",{unitStart:0,quote:"文。第二"}],
    ["第一文。第二文。",{unitStart:0,quote:"第二文。"}], ["第一文。第二文。",{unitStart:1,quote:"第一"}],
    ["𠮷は青色。",{unitStart:0,quote:"\ud842"}], ["éは青色。",{unitStart:0,quote:"e\u0301"}],
  ])("refuses ambiguous or transformed anchor in %s",(text,anchor)=>expect(()=>resolveReviewAnchor(text,anchor)).toThrow("ai_incomplete"));
  it("derives unique whole-character UTF16 positions without changing the reply",()=>{
    const text="前文。𠮷は青色。",anchor={unitStart:3,quote:"𠮷"},before=JSON.stringify(anchor);
    expect(resolveReviewAnchor(text,anchor)).toEqual({start:3,end:5,quote:"𠮷"});expect(JSON.stringify(anchor)).toBe(before);
  });
  it("binds the digest to all five exact fields and never repairs a changed draft",()=>{
    const {plan,drafts,input,answer}=example(); drafts[0].common="主装置又は補助装置は光・音・振動のいずれかを備える。";
    const changed=reviewInput(plan,drafts);expect(changed.targets[2].text).toBe(drafts[0].common);expect(changed.draftDigest).not.toBe(input.draftDigest);
    expect(()=>validateReview(changed,answer)).toThrow("ai_incomplete");
  });
  it("preflights maximum drafts and a 200-unit field without clipping",()=>{
    const {plan,drafts}=example();expect(()=>assertReviewPlan(plan)).not.toThrow();
    drafts[0].common="。a".repeat(100);const input=reviewInput(plan,drafts),answer=fictionalReview(input);
    expect(answer.checks[2].unitChecks).toHaveLength(101);expect(()=>validateReview(input,answer)).not.toThrow();
    input.base={...input.base,claims:[{...input.base.claims[0],segments:[["b:1:0","大".repeat(30000)]]}]};
    expect(()=>assertReviewSize(input)).toThrow("plan_limit");
  });
  it("reserves lone-surrogate escaping before any draft is generated",()=>{
    const {plan,drafts}=example();
    const envelope=(character:string)=>drafts.map(d=>({...d,baseObservation:character.repeat(120),candidateObservation:character.repeat(120),common:character.repeat(200),differences:character.repeat(200),unconfirmed:character.repeat(120)}));
    const pad=(n:number)=>plan.map(c=>({...c,base:{...c.base,claims:c.base.claims.map((claim,i)=>i?claim:{...claim,text:claim.text+"X".repeat(n)})}}));
    const size=(n:number)=>{const input=reviewInput(pad(n),envelope("\\"));return requestBytes(REVIEW_SYSTEM,JSON.stringify(input),reviewSchemaFor(input));};
    let lower=0,upper:number=LIMITS.inputBytes;while(lower+1<upper){const middle=Math.floor((lower+upper)/2);if(size(middle)<=LIMITS.inputBytes)lower=middle;else upper=middle;}
    expect(size(lower+1)).toBeGreaterThan(LIMITS.inputBytes);expect(()=>assertReviewSize(reviewInput(pad(lower),envelope("\\")))).not.toThrow();
    expect(()=>assertReviewSize(reviewInput(pad(lower),envelope("\ud800")))).toThrow("plan_limit");expect(()=>assertReviewPlan(pad(lower))).toThrow("plan_limit");
  });
  it("keeps complete partition text, punctuation and the lone-surrogate envelope",()=>{
    const {plan,drafts}=example();const size=(text:string)=>{const input=reviewInput(plan,drafts.map(d=>({...d,common:text,differences:text})));return requestBytes(REVIEW_SYSTEM,JSON.stringify(input),reviewSchemaFor(input));};
    for(const text of ["基準は光。候補は音。","𠮷は青色。　次は赤色。　","一文だけ","句点。。次。","。".repeat(200)]){
      const units=reviewTargetUnits(text);expect(units.map(u=>u.text).join("")).toBe(text);for(const u of units)expect(text.slice(u.start,u.end)).toBe(u.text);
    }
    for(const text of ["あ。".repeat(100),"\ud800。".repeat(100),"。x".repeat(100),"a。".repeat(100),"。".repeat(200)])expect(size(text)).toBeLessThanOrEqual(size("\ud800".repeat(200)));
    expect(reviewSchema.safeParse({draftDigest:"a".repeat(64),checks:Array.from({length:20},(_,i)=>({id:String(i),unitChecks:Array.from({length:200},(_,start)=>({start,evidenceIds:[],sourceComparison:"境界",verdict:"uncertain",rejectedTargetAnchor:null}))}))}).success).toBe(true);
  });
  it("preserves original quote coordinates and old six-pair saved snapshots",()=>{
    const {plan,drafts,input,inputs,selection}=example();
    for(const [i,pair] of input.pairs.entries())for(const side of ["base","candidate"] as const){
      const source=side==="base"?input.base:input.documents.find(d=>d.docId===pair.docId)!.source,anchor=pair[`${side}Evidence`];
      const text=source.claims.find(c=>c.claimNo===anchor.claimNo)!.segments.map(([,t])=>t).join("");expect(text.slice(anchor.start,anchor.end)).toBe(drafts[i][`${side}Evidence`].quote);expect(anchor).not.toHaveProperty("quote");
    }
    expect(plan).toHaveLength(3);selection.documents.forEach(d=>d.claimNos=[1,2]);expect(()=>makePlan(inputs,selection)).toThrow("plan_limit");
    const saved=fictionalSaved();Object.assign(saved,{inputs,selection,operationId:selection.operationId});
    saved.pairs=inputs.documents.flatMap(d=>[1,2].map(no=>({docId:d.id,baseClaimNo:1,candidateClaimNo:no,common:"原文範囲を比較。",differences:"対応は要確認。",unconfirmed:"図面は未確認。",baseEvidence:{claimNo:1,quote:inputs.draft.source.claims[0].text,start:0,end:inputs.draft.source.claims[0].text.length},candidateEvidence:{claimNo:no,quote:d.source.claims[no-1].text,start:0,end:d.source.claims[no-1].text.length}})));
    saved.snapshotDigest=savedDigest(saved);expect(validateSaved(saved).pairs).toHaveLength(6);
  });
});
