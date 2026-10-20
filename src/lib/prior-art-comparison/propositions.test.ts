import { describe, expect, it } from "vitest";
import { compareProposition, explainProposition, meaningSchema, type Meaning, type SourceProposition, type TargetProposition } from "./propositions";
import { renderMeaning } from "./proposition-result";

const guard = { relation: "unconditional" as const, conditions: [] };
const set = (subject: string | null, members: string[], selection: "required" | "nonempty" | "one" = "nonempty"): Meaning =>
  ({ kind:"set",subject,context:"capability",guard,polarity:"positive",selection,extent:"closed",members });
const source = (id: string, meaning: Meaning): SourceProposition =>
  ({ id,scope:"base:3",claimNo:3,basis:[[0,30]],meaning,authority:"extracted" });
const target = (meaning: Meaning, sourceIds = ["s1"]): TargetProposition =>
  ({ id:"t1",targetId:"1:3:7:differences",span:[0,40],sourceIds,scope:"base:3",claimNo:3,meaning });
const path = (via: string[], bypass: string[]): Meaning => ({kind:"path",subject:"第1運転モード",context:"operation",guard,polarity:"positive",
  origin:"出口",destination:"入口",via,bypass,extent:"segment",relation:"route"});

describe("position-bound proposition comparison (fictional extraction, not AI quality)",()=>{
  it.each([
    ["generates_heat","発熱させる"], ["absorbs_heat","吸熱させる"],
    ["releases_heat","放熱させる"], ["fully_closes","全閉にする"],
  ] as const)("retains the exact action and guarded component for %s",(predicate,label)=>{
    const m:Meaning={kind:"relation",subject:"紫色モード",context:"operation",guard:{relation:"when",conditions:["始動時"]},polarity:"positive",predicate,objects:["試験器"]};
    expect(meaningSchema.parse(m)).toEqual(m);
    expect(compareProposition(target(m),[source("s1",m)])).toMatchObject({relation:"entailed",rule:"relation_matches"});
    expect(renderMeaning(m)).toContain(`試験器${predicate==="absorbs_heat"||predicate==="releases_heat"?"で":"を"}${label}`);
    expect(renderMeaning({...m,context:"capability"})).toContain("機能を備える");
    for(const other of ["has","opens","closes","generates_heat","absorbs_heat","releases_heat","fully_closes"] as const){
      if(other!==predicate)expect(compareProposition(target(m),[source("s1",{...m,predicate:other})]).relation).toBe("unresolved");
    }
    expect(compareProposition(target(m),[source("s1",{...m,guard})]).relation).toBe("unresolved");
    expect(compareProposition(target(m),[source("s1",{...m,objects:["別の試験器"]})]).relation).toBe("unresolved");
    expect(compareProposition(target(m),[source("s1",{...m,subject:"別モード"})]).relation).toBe("unresolved");
  });
  it("finds a closed-set omission and derives its reason from the same counterexample",()=>{
    const r=compareProposition(target(set("補助系",["青","黄"])),[source("s1",set("補助系",["青","黄","紫","緑"]))]);
    expect(r).toMatchObject({relation:"contradicted",rule:"closed_set_changed",delta:{missing:["紫","緑"],added:[],counterexample:["紫"]}});
    expect(explainProposition(r)).toContain("脱落:紫・緑");
    expect(explainProposition(r)).toContain("対象[0:40]、原文請求項3[0:30]");
  });
  it("distinguishes a required capability from another subject's alternatives",()=>{
    const r=compareProposition(target(set(null,["赤","青","黄"]),["fixed","choice"]),
      [source("fixed",set("主系",["赤"],"required")),source("choice",set("補助系",["青","黄"]))]);
    expect(r).toMatchObject({relation:"contradicted",rule:"required_optionalized",delta:{missing:["赤"],counterexample:["青"]}});
    expect(explainProposition(r)).toContain("青だけの選択では必須条件を満たさない");
  });
  it("keeps valid partial membership distinct from closed equality",()=>{
    const m=set("補助系",["青"],"one"); if(m.kind==="set")m.extent="partial";
    expect(compareProposition(target(m),[source("s1",set("補助系",["青","黄"]))])).toMatchObject({relation:"entailed",rule:"partial_membership"});
  });
  it.each(["subject","branch","context","guard","polarity"])("does not borrow a condition across %s",axis=>{
    const t=target(set("補助系",["青","黄"]));
    if(axis==="subject")t.meaning.subject="別系";
    if(axis==="branch")t.claimNo=2;
    if(axis==="context")t.meaning.context="operation";
    if(axis==="guard")t.meaning.guard={relation:"when",conditions:["始動時"]};
    if(axis==="polarity")t.meaning.polarity="negative";
    expect(compareProposition(t,[source("s1",set("補助系",["青","黄"]))]).relation).toBe("unresolved");
  });
  it("does not treat dropping a sufficient condition as a proven contradiction",()=>{
    const s=source("s1",set("補助系",["青","黄"]));s.meaning.guard={relation:"when",conditions:["高温時"]};
    expect(compareProposition(target(set("補助系",["青","黄"])),[s])).toMatchObject({relation:"unresolved",rule:"guard_lost"});
  });
  it("compares via/bypass only with matching endpoints",()=>{
    expect(compareProposition(target(path(["中間槽"],[])),[source("s1",path([],["中間槽"]))])).toMatchObject({relation:"contradicted",rule:"path_conflict"});
    const t=target(path(["中間槽"],[]));if(t.meaning.kind==="path")t.meaning.origin=null;
    expect(compareProposition(t,[source("s1",path([],["中間槽"]))]).relation).toBe("unresolved");
  });
  it("requires the whole route and explicit exclusions for a missing-origin order assertion",()=>{
    const s=source("s1",path(["外槽","貯槽"],["内槽"]));
    const m=path(["内槽"],[]);if(m.kind==="path"){m.origin=null;m.destination="貯槽";m.relation="precedes";m.extent="unresolved";}
    const t=target(m);
    expect(compareProposition(t,[s]).relation).toBe("unresolved");
    if(s.meaning.kind==="path")s.meaning.extent="whole";
    expect(compareProposition(t,[s]).relation).toBe("unresolved");
    s.routeFrame={entry:[0,2],exit:[28,30],route:[0,30],exclusions:[[5,12]],controls:[[12,20]]};
    expect(compareProposition(t,[s])).toMatchObject({relation:"contradicted",rule:"whole_route_exclusion"});
    if(s.meaning.kind==="path")s.meaning.via.unshift("内槽");
    expect(compareProposition(t,[s])).toMatchObject({relation:"entailed",rule:"order_matches"});
  });
  it("does not collapse a multiple-assertion sentence into its true later assertion",()=>{
    const a=compareProposition(target(set("補助系",["青"])),[source("s1",set("補助系",["青","黄"]))]);
    const b=compareProposition(target(set("主系",["赤"],"required")),[source("s1",set("主系",["赤"],"required"))]);
    expect([a.relation,b.relation]).toEqual(["contradicted","entailed"]);
  });
  it("checks a whole route with its compatible literal bypass constraint",()=>{
    const s=source("whole",path(["外槽","貯槽"],["内槽"]));
    if(s.meaning.kind==="path")s.meaning.extent="whole";
    s.routeFrame={entry:[0,2],exit:[28,30],route:[0,30],exclusions:[[5,12]],controls:[[12,20]]};
    const literal=source("literal",path([],["内槽"]));literal.authority="literal";
    if(literal.meaning.kind==="path"){literal.meaning.origin="外槽";literal.meaning.destination="貯槽";}
    const m=path(["内槽"],[]);if(m.kind==="path"){m.origin=null;m.destination="貯槽";m.relation="precedes";m.extent="unresolved";}
    expect(compareProposition(target(m,["whole","literal"]),[s,literal])).toMatchObject({relation:"contradicted",rule:"whole_route_exclusion"});
    if(literal.meaning.kind==="path")literal.meaning.bypass=["貯槽"];
    // Excluding the segment endpoint would not be a valid bypass constraint.
    expect(compareProposition(target(m,["whole","literal"]),[s,literal]).relation).toBe("unresolved");
  });
  it("requires a complete frame for ordinary whole-route equality too",()=>{
    const m=path(["外槽","貯槽"],["内槽"]);if(m.kind==="path")m.extent="whole";
    const s=source("s1",m);
    expect(compareProposition(target(m),[s]).relation).toBe("unresolved");
    s.routeFrame={entry:[0,2],exit:[28,30],route:[0,30],exclusions:[[5,12]],controls:[[12,20]]};
    expect(compareProposition(target(m),[s])).toMatchObject({relation:"entailed",rule:"path_matches"});
  });
  it("does not treat an opening capability as excluding a closing capability",()=>{
    const m:Meaning={kind:"relation",subject:"制御器",context:"capability",guard,polarity:"positive",predicate:"opens",objects:["主弁"]};
    const s=source("s1",{...m,predicate:"closes"}),t=target(m);
    expect(compareProposition(t,[s]).relation).toBe("unresolved");
    s.meaning.context="operation";t.meaning.context="operation";
    expect(compareProposition(t,[s])).toMatchObject({relation:"contradicted",rule:"relation_changed"});
  });
  it("does not conflate unqualified temporal order with a flow position",()=>{
    const m={kind:"relation",subject:"冷却動作",context:"operation",guard,polarity:"positive",predicate:"before",objects:["加熱動作"]};
    expect(meaningSchema.safeParse(m).success).toBe(false);
    expect(meaningSchema.safeParse({...m,subject:"加熱器",predicate:"upstream",objects:["放熱器"]}).success).toBe(true);
  });
});
