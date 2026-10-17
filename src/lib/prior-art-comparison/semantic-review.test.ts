import { describe, expect, it } from "vitest";
import { makePlan, SYSTEM, validateAnswer, validateSaved, savedDigest, LIMITS } from "./comparison";
import { fictionalAnswer, fictionalInputs, fictionalReview, fictionalSaved } from "./fixtures.test-support";
import { batchInput, batchSchemaFor, generationBatches, requestBytes } from "./generation-batch";
import { assertReviewPlan, assertReviewSize, inspectReviewCoverage, resolveReviewAnchor, resolveReviewSpan, reviewContrastCuts, reviewEvidenceCatalog, reviewInput, reviewSchema, reviewSchemaFor, reviewTargetUnits, REVIEW_SYSTEM, validateReview } from "./semantic-review";
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
  function referenceExample(text = "請求項1-2の装置。") {
    const { plan, drafts } = example(); drafts[0].baseObservation = text;
    const input = reviewInput(plan, drafts), answer = fictionalReview(input);
    return { input, answer, unit: answer.checks[0].unitChecks[0] };
  }
  it("binds lexical reference hints to full target text without normalizing it", () => {
    const text = "𠮷。請求項１／２の装置。請求項2までの装置。", { input, answer } = referenceExample(text);
    expect(input.targets[0].text).toBe(text);
    expect(input.targets[0].mentions).toEqual([[3, 9], [13, 19]]);
    expect(answer.checks[0].unitChecks.map(u => u.referenceChecks.map(r => r.start))).toEqual([[], [3], [13]]);
    expect(() => validateReview(input, answer)).not.toThrow();
    input.targets[0].mentions = [[3, 8], [13, 19]];
    expect(() => inspectReviewCoverage(input, answer)).toThrow("ai_incomplete");
  });
  it.each(["missing", "duplicate", "foreign", "all_without_basis", "any_without_basis", "range_basis", "wrong_basis", "legacy", "unresolved_as_c"])("refuses %s reference readings before saving", mode => {
    const { input, answer, unit } = referenceExample();
    if (mode === "missing") unit.referenceChecks = [];
    if (mode === "duplicate") unit.referenceChecks.push({ ...unit.referenceChecks[0] });
    if (mode === "foreign") unit.referenceChecks[0].start++;
    if (mode === "all_without_basis") unit.referenceChecks[0].relation = "all";
    if (mode === "any_without_basis") unit.referenceChecks[0].relation = "any";
    if (mode === "range_basis") Object.assign(unit.referenceChecks[0], { relation: "all", operatorBasis: { start: 0, quote: "請求項1-2" } });
    if (mode === "wrong_basis") Object.assign(unit.referenceChecks[0], { relation: "all", operatorBasis: { start: 0, quote: "全て" } });
    if (mode === "legacy") delete (unit as Partial<typeof unit>).referenceChecks;
    if (mode === "unresolved_as_c") unit.referenceChecks[0].relation = "unresolved";
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
  });
  it("keeps unresolved and inconsistent units stopped instead of promoting unspecified to C", () => {
    const { input, answer, unit } = referenceExample();
    unit.referenceChecks[0].relation = "unresolved"; unit.contrasts[0].verdict = "uncertain";
    expect(inspectReviewCoverage(input, answer).checks[0].verdict).toBe("uncertain");
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
    unit.referenceChecks[0].relation = "unspecified"; unit.contrasts[0].verdict = "inconsistent"; unit.contrasts[0].rejectedTargetSpan = [0, input.targets[0].text.length];
    expect(inspectReviewCoverage(input, answer).checks[0].verdict).toBe("inconsistent");
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
  });
  it("checks an explicit quantifier at the exact position without rewriting the raw reply", () => {
    const { input, answer, unit } = referenceExample("請求項1-2の全てを継承する。");
    Object.assign(unit.referenceChecks[0], { relation: "all", operatorBasis: { start: input.targets[0].text.indexOf("全て"), quote: "全て" } });
    const before = JSON.stringify(answer);
    expect(() => validateReview(input, answer)).not.toThrow(); expect(JSON.stringify(answer)).toBe(before);
    unit.referenceChecks[0].operatorBasis!.start--;
    expect(() => validateReview(input, answer)).toThrow("ai_incomplete");
  });
  it("binds combination rejection to actual quantification while preserving a real reference-scope rejection",()=>{
    const {input,answer,unit}=referenceExample(), contrast=unit.contrasts[0];
    Object.assign(contrast,{kind:"reference_combination",referenceStart:0,verdict:"inconsistent",rejectedTargetSpan:[0,input.targets[0].text.length]});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    contrast.kind="reference_scope";
    expect(inspectReviewCoverage(input,answer).checks[0].verdict).toBe("inconsistent");
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    contrast.kind="reference_combination";contrast.verdict="uncertain";contrast.rejectedTargetSpan=null;
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    unit.referenceChecks[0].relation="unresolved";
    expect(inspectReviewCoverage(input,answer).checks[0].verdict).toBe("uncertain");
  });
  it.each(["consistent","inconsistent","uncertain"] as const)("never forces a mixed unspecified combination group into %s",verdict=>{
    const {input,answer,unit}=referenceExample("請求項1/2の装置は、100度以上で弁を開く。"),contrast=unit.contrasts[0];
    Object.assign(contrast,{kind:"reference_combination",referenceStart:0,verdict,rejectedTargetSpan:verdict==="inconsistent"?[0,input.targets[0].text.length]:null});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    contrast.kind="technical";contrast.referenceStart=null;
    expect(inspectReviewCoverage(input,answer).checks[0].verdict).toBe(verdict);
    contrast.kind="reference_scope";contrast.referenceStart=0;
    expect(inspectReviewCoverage(input,answer).checks[0].verdict).toBe(verdict);
  });
  it("permits grounded disagreement with an explicit all relation without changing its raw reading",()=>{
    const {input,answer,unit}=referenceExample("請求項1-2の全てを継承する。"), contrast=unit.contrasts[0];
    Object.assign(unit.referenceChecks[0],{relation:"all",operatorBasis:{start:input.targets[0].text.indexOf("全て"),quote:"全て"}});
    Object.assign(contrast,{kind:"reference_combination",referenceStart:0,verdict:"inconsistent",rejectedTargetSpan:[0,input.targets[0].text.length]});
    const before=JSON.stringify(answer), checked=inspectReviewCoverage(input,answer);
    expect(checked.checks[0].verdict).toBe("inconsistent");expect(JSON.stringify(answer)).toBe(before);
  });
  it.each(["missing_end","duplicate_end","foreign_end","outside_unit","wrong_kind","missing_ref","foreign_ref","other_group_ref","free_aggregate","legacy_anchor"])("refuses %s contrast binding",mode=>{
    const {input,answer,unit}=referenceExample("請求項1-2の装置は、圧力が上限を超える場合には動作しない。"), c=unit.contrasts[0];
    if(mode==="missing_end")c.end=input.targets[0].contrastCuts![0];
    if(mode==="duplicate_end")unit.contrasts.push({...c});
    if(mode==="foreign_end")c.end=1;
    if(mode==="outside_unit")c.end=input.targets[0].text.length+1;
    if(mode==="wrong_kind")c.referenceStart=0;
    if(mode==="missing_ref")c.kind="reference_scope";
    if(mode==="foreign_ref")Object.assign(c,{kind:"reference_scope",referenceStart:99});
    if(mode==="other_group_ref")Object.assign(c,{kind:"reference_scope",referenceStart:0,end:input.targets[0].contrastCuts![0]});
    if(mode==="free_aggregate")Object.assign(unit,{verdict:"consistent"});
    if(mode==="legacy_anchor")Object.assign(c,{rejectedTargetAnchor:null});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("can group a condition and its negative conclusion while retaining every intermediate position hint",()=>{
    const {input,answer,unit}=referenceExample("圧力が上限を超えた場合、制御を実行しない。"), before=JSON.stringify(answer);
    expect(input.targets[0].contrastCuts).toContain(input.targets[0].text.indexOf("、")+1);
    expect(unit.contrasts[0].end).toBe(input.targets[0].text.length);
    expect(()=>validateReview(input,answer)).not.toThrow();expect(JSON.stringify(answer)).toBe(before);
    const cut=input.targets[0].contrastCuts![0];
    unit.contrasts=[{...unit.contrasts[0],end:cut},{...unit.contrasts[0]}];
    const derived=inspectReviewCoverage(input,answer).checks[0].unitChecks[0];
    expect(derived.contrasts.map(c=>input.targets[0].text.slice(c.start,c.end)).join("")).toBe(input.targets[0].text);
    expect(derived.verdict).toBe("consistent");
  });
  it("aggregates each literal contrast and never lets a later correct fragment hide an earlier failure",()=>{
    const {input,answer,unit}=referenceExample("経路は吸熱器を通る、弁は開く。"), first=unit.contrasts[0], cut=input.targets[0].contrastCuts![0];
    unit.contrasts=[{...first,end:cut,verdict:"inconsistent",rejectedTargetSpan:[0,cut]},{...first}];
    const before=JSON.stringify(answer), result=inspectReviewCoverage(input,answer).checks[0];
    expect(result.verdict).toBe("inconsistent");expect(result.rejectedTargetAnchor).toEqual({unitStart:0,quote:input.targets[0].text.slice(0,cut)});
    expect(result.unitChecks[0].evidenceIds).toHaveLength(first.evidenceIds.length);expect(JSON.stringify(answer)).toBe(before);
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    unit.contrasts[0].rejectedTargetSpan=[cut,input.targets[0].text.length];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("keeps Unicode-safe cut catalogs bound to the exact full target",()=>{
    const text="𠮷".repeat(31)+"、請求項一𠮷請求項二の装置。　次の条件。",{input,answer}=referenceExample(text),t=input.targets[0];
    const cuts=reviewContrastCuts(text);
    expect(t.contrastCuts).toEqual(cuts);
    for(const at of cuts)expect(!(/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]))).toBe(true);
    expect(()=>validateReview(input,answer)).not.toThrow();t.contrastCuts=[1];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("resolves negative spans only at catalog boundaries, in their actual contrast and unique unit position",()=>{
    const text="𠮷は青色、赤色にはしない。",cuts=reviewContrastCuts(text),end=text.length;
    expect(resolveReviewSpan(text,0,[0,end],{start:0,end})).toEqual({start:0,end,quote:text});
    expect(()=>resolveReviewSpan(text,0,[1,end],{start:0,end})).toThrow("ai_incomplete");
    expect(()=>resolveReviewSpan(text,0,[0,end],{start:0,end:cuts[0]})).toThrow("ai_incomplete");
    const repeated="あ".repeat(200), grid=reviewContrastCuts(repeated);
    expect(()=>resolveReviewSpan(repeated,0,[0,grid[0]],{start:0,end:200})).toThrow("ai_incomplete");
    expect(()=>resolveReviewSpan(repeated,0,[0,200],{start:0,end:200})).toThrow("ai_incomplete");
  });
  it("preflights mixed surrogate/reference metadata at every bounded field length", () => {
    const { plan, drafts } = example();
    const envelope = (text: (n: number) => string) => drafts.map(d => ({ ...d, baseObservation: text(120), candidateObservation: text(120), common: text(200), differences: text(200), unconfirmed: text(120) }));
    const size = (d: typeof drafts) => { const input = reviewInput(plan, d); return requestBytes(REVIEW_SYSTEM, JSON.stringify(input), reviewSchemaFor(input)); };
    const maximum = envelope(n => "\ud800".repeat(n)), hints = reviewInput(plan, maximum);
    const upper = size(maximum) + hints.targets.reduce((n,t)=>n+32+Math.floor(t.text.length/4)*2,0);
    for (const mention of ["請求項1", "請求項１", "請求項一", "請求項1/2", "請求項１乃至請求項９９", "請求項12まで", "請求項999から9999"]) {
      for (const offset of [0, 1, 9, 99, 110, 119, 190]) {
        const actual = envelope(n => { const prefix = "\ud800".repeat(Math.min(offset, n)); return (prefix + (mention + "。").repeat(n)).slice(0, n); });
        expect(size(actual)).toBeLessThanOrEqual(upper);
      }
    }
    expect(() => assertReviewPlan(plan)).not.toThrow();
  });
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
  it("uses unique review ordinals including zero and losslessly derives original UTF16 keys",()=>{
    const {input,answer}=example(),catalog=reviewEvidenceCatalog(input),keys=[...catalog.keys()];
    expect(keys).toEqual(keys.map((_,i)=>i));expect(catalog.get(0)).toMatchObject({side:"base",docId:null,claimNo:1,start:0,key:"b:1:0"});
    for(const source of [input.base,...input.documents.map(d=>d.source)])for(const claim of source.claims){
      const entries=claim.segments.map(([id])=>catalog.get(id)!);
      expect(entries.map(e=>e.text).join("")).toBe(claim.segments.map(([,t])=>t).join(""));
      expect(entries.at(-1)?.end).toBe(entries.map(e=>e.text).join("").length);
    }
    answer.checks[0].unitChecks[0].contrasts[0].evidenceIds=[0];
    expect(inspectReviewCoverage(input,answer).checks[0].unitChecks[0].contrasts[0].evidenceKeys).toEqual(["b:1:0"]);
    input.documents[0].source.claims[0].segments[0]=[0,input.documents[0].source.claims[0].segments[0][1]];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each(["string","fraction","negative","unsafe"])("refuses %s review evidence ordinals without coercion",mode=>{
    const {input,answer}=example(),contrast=answer.checks[0].unitChecks[0].contrasts[0];
    Object.assign(contrast,{evidenceIds:[mode==="string"?"0":mode==="fraction"?0.5:mode==="negative"?-1:Number.MAX_SAFE_INTEGER+1]});
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("keeps selected claims with shared ancestors as separate scopes and derives all actual support numbers",()=>{
    const {inputs,selection}=compactThree(); selection.documents=selection.documents.slice(0,2);
    selection.documents.forEach(d=>d.claimNos=[1,2]);
    const plan=makePlan(inputs,selection), drafts=plan.flatMap(c=>validateAnswer(c,fictionalAnswer(c)).map(p=>({...p,baseObservation:"基準",candidateObservation:"候補"})));
    const input=reviewInput(plan,drafts), answer=fictionalReview(input);
    expect(input.scopes.map(s=>s.id)).toEqual(["base:1","candidate:21:1","candidate:21:2","candidate:22:1","candidate:22:2"]);
    const check=answer.checks.find(c=>c.id==="21:1:2:common")!;
    check.unitChecks[0].contrasts[0].evidenceIds=[input.base.claims[0].segments[0][0],...input.documents[0].source.claims.flatMap(c=>c.segments.map(([id])=>id))];
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
    if(mode==="blank")check.unitChecks[0].contrasts[0].sourceComparison="　 ";
    if(mode==="control")check.unitChecks[0].contrasts[0].sourceComparison="対比\n未完";
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it.each(["unknown","duplicate","wrong_side","wrong_document","missing_base","missing_candidate"])("refuses %s evidence for C/I and never silently fills support",mode=>{
    for(const verdict of ["consistent","inconsistent"] as const){
      const {input,answer}=example(), at=mode==="missing_base"||mode==="missing_candidate"?2:mode==="wrong_document"?1:0, unit=answer.checks[at].unitChecks[0];
      unit.contrasts[0].verdict=verdict; if(verdict==="inconsistent")unit.contrasts[0].rejectedTargetSpan=[0, reviewTargetUnits(input.targets[at].text)[0].end];
      if(mode==="unknown")unit.contrasts[0].evidenceIds=[999999];
      if(mode==="duplicate")unit.contrasts[0].evidenceIds.push(unit.contrasts[0].evidenceIds[0]);
      if(mode==="wrong_side")unit.contrasts[0].evidenceIds=[input.documents[0].source.claims[0].segments[0][0]];
      if(mode==="wrong_document")unit.contrasts[0].evidenceIds=[input.documents[1].source.claims[0].segments[0][0]];
      const baseIds=new Set(input.base.claims.flatMap(c=>c.segments.map(s=>s[0])));
      if(mode==="missing_base")unit.contrasts[0].evidenceIds=unit.contrasts[0].evidenceIds.filter(id=>!baseIds.has(id));
      if(mode==="missing_candidate")unit.contrasts[0].evidenceIds=unit.contrasts[0].evidenceIds.filter(id=>baseIds.has(id));
      expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    }
  });
  it("refuses a canonical catalog ID outside this pair's selected closure",()=>{
    const {inputs,selection}=compactThree();selection.documents[0].claimNos=[1,2];
    const plan=makePlan(inputs,selection),drafts=plan.flatMap(c=>validateAnswer(c,fictionalAnswer(c)).map(p=>({...p,baseObservation:"基準条件。",candidateObservation:"候補条件。"})));
    const input=reviewInput(plan,drafts),answer=fictionalReview(input),id=input.documents[0].source.claims.find(c=>c.claimNo===2)!.segments[0][0];
    const check=answer.checks.find(c=>c.id==="21:1:1:candidateObservation")!;
    expect(reviewEvidenceCatalog(input).get(id)).toMatchObject({docId:21,claimNo:2});
    check.unitChecks[0].contrasts[0].evidenceIds=[id];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("refuses whitespace evidence after its canonical ID passes catalog validation",()=>{
    const {input,answer}=example(),[id]=input.base.claims[0].segments[0];
    input.base.claims[0].segments[0]=[id,"　 "];
    expect(reviewEvidenceCatalog(input).get(id)?.text).toBe("　 ");
    answer.checks[0].unitChecks[0].contrasts[0].evidenceIds=[id];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("bounds dense commas, references and mixed Unicode without clipping any field",()=>{
    const {plan,drafts}=example();
    const envelope=(pattern:string)=>drafts.map(d=>{const text=(n:number)=>pattern.repeat(n).slice(0,n);return {...d,baseObservation:text(120),candidateObservation:text(120),common:text(200),differences:text(200),unconfirmed:text(120)};});
    const max=reviewInput(plan,envelope("\ud800")),upper=requestBytes(REVIEW_SYSTEM,JSON.stringify(max),reviewSchemaFor(max))+max.targets.reduce((n,t)=>n+32+2*Math.floor(t.text.length/4),0);
    for(const pattern of ["、","請求項一\ud800","請求項1\ud800","請求項一、","𠮷、","\ud800。","請求項1/2、","\ud842、\udc00"]){
      const variants=envelope(pattern),input=reviewInput(plan,variants);
      expect(requestBytes(REVIEW_SYSTEM,JSON.stringify(input),reviewSchemaFor(input))).toBeLessThanOrEqual(upper);
      expect(input.targets[2].text).toBe(variants[0].common);
    }
  });
  it("allows unresolved proof only as U, refuses invalid U references, and never saves U",()=>{
    const {input,answer}=example(), unit=answer.checks[2].unitChecks[0];
    Object.assign(unit.contrasts[0],{verdict:"uncertain",evidenceIds:[],sourceComparison:"必要な参照枝の解釈を解決できない。"});
    expect(inspectReviewCoverage(input,answer).checks[2].verdict).toBe("uncertain");
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    const baseId=input.base.claims[0].segments[0][0];
    for(const ids of [[999999],[baseId,baseId],[input.documents[1].source.claims[0].segments[0][0]]]){
      unit.contrasts[0].evidenceIds=ids;expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
    }
  });
  it.each(["consistent","inconsistent"] as const)("accepts %s contrast with each side grounded in its own sentence",verdict=>{
    const {plan,drafts}=example();drafts[0].differences="基準側は光を必須とする。候補側は音又は振動を備える。";
    const input=reviewInput(plan,drafts),answer=fictionalReview(input),check=answer.checks[3],units=reviewTargetUnits(input.targets[3].text);
    check.unitChecks[0].contrasts[0].evidenceIds=[input.base.claims[0].segments[0][0]];
    check.unitChecks[1].contrasts[0].evidenceIds=[input.documents[0].source.claims[0].segments[0][0]];
    Object.assign(check.unitChecks[0].contrasts[0],{verdict,rejectedTargetSpan:verdict==="inconsistent"?[units[0].start,units[0].end]:null});
    expect(inspectReviewCoverage(input,answer).checks[3].verdict).toBe(verdict);
    if(verdict==="consistent")expect(()=>validateReview(input,answer)).not.toThrow();else expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    check.unitChecks[1].contrasts[0].evidenceIds=[input.base.claims[0].segments[0][0]];
    expect(()=>inspectReviewCoverage(input,answer)).toThrow("ai_incomplete");
  });
  it("retains complete contrast longer than the old 80-character cap",()=>{
    const {input,answer}=example(), text="原文の対象、条件、経路を当該文の全断定と対比する。".repeat(20);
    answer.checks[2].unitChecks[0].contrasts[0].sourceComparison=text;
    expect(inspectReviewCoverage(input,answer).checks[2].unitChecks[0].sourceComparison).toBe(text);
    expect(()=>validateReview(input,answer)).not.toThrow();
  });
  it("aggregates I before U before C in source order, while validating raw negative reports",()=>{
    const {input,answer}=example(), check=answer.checks[0], units=reviewTargetUnits(input.targets[0].text);
    Object.assign(check.unitChecks[0].contrasts[0],{verdict:"uncertain",evidenceIds:[]});
    Object.assign(check.unitChecks[1].contrasts[0],{verdict:"inconsistent",rejectedTargetSpan:[units[1].start,units[1].end]});
    check.unitChecks.reverse();
    expect(inspectReviewCoverage(input,answer).checks[0]).toMatchObject({verdict:"inconsistent",rejectedTargetAnchor:{unitStart:units[1].start,quote:units[1].text}});
    expect(()=>validateReview(input,answer)).toThrow("ai_incomplete");
    Object.assign(check.unitChecks[1].contrasts[0],{verdict:"inconsistent",evidenceIds:[input.base.claims[0].segments[0][0]],rejectedTargetSpan:[units[0].start,units[0].end]});
    expect(inspectReviewCoverage(input,answer).checks[0].rejectedTargetAnchor?.unitStart).toBe(0);
  });
  it.each(["missing","empty","foreign","other_unit","long","consistent","uncertain"])("refuses %s negative anchor",mode=>{
    const {input,answer}=example(), unit=answer.checks[0].unitChecks[0];
    const spans=reviewTargetUnits(input.targets[0].text), contrast=unit.contrasts[0];
    Object.assign(contrast,{verdict:"inconsistent",rejectedTargetSpan:[spans[0].start,spans[0].end]});
    if(mode==="missing")contrast.rejectedTargetSpan=null;
    if(mode==="empty")contrast.rejectedTargetSpan=[0,0];
    if(mode==="foreign")contrast.rejectedTargetSpan=[0,999];
    if(mode==="other_unit")contrast.rejectedTargetSpan=[spans[1].start,spans[1].end];
    if(mode==="long")contrast.rejectedTargetSpan=[0,121];
    if(mode==="consistent"||mode==="uncertain")unit.contrasts[0].verdict=mode;
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
    input.base={...input.base,claims:[{...input.base.claims[0],segments:[[0,"大".repeat(30000)]]}]};
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
    expect(reviewSchema.safeParse({draftDigest:"a".repeat(64),checks:Array.from({length:20},(_,i)=>({id:String(i),unitChecks:Array.from({length:200},(_,start)=>({start,referenceChecks:[],contrasts:[{end:start+1,kind:"technical",referenceStart:null,evidenceIds:[],sourceComparison:"境界",verdict:"uncertain",rejectedTargetSpan:null}]}))}))}).success).toBe(true);
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
