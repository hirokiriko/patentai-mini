import { renderMeaning } from "./proposition-result";
import { expect, it } from "vitest";
import { closedFactInput, reviewSupportInput } from "./closed-fact-input";
import { canonicalPropositionSources, type PropositionTargetInput } from "./proposition-extraction";
import { makePlan } from "./comparison";
import { fictionalInputs } from "./fixtures.test-support";
import { compareProposition, type SourceProposition, type TargetProposition } from "./propositions";

const meaning = { kind: "relation" as const, subject: "制御器", context: "operation" as const,
  guard: { relation: "when" as const, conditions: ["駆動機を起動する際", "起動後の所定期間"] },
  polarity: "positive" as const, predicate: "maintains" as const, objects: ["青弁の開度を所定値に維持する"] };
const fact = (id: string): SourceProposition => ({ id, scope: "base:1", claimNo: 1,
  basis: [[0, 30]], meaning, authority: "extracted" });

it("retains original facts and complete rendered conditions without inventing a closed missing claim", () => {
  const f = fictionalInputs(), sources = canonicalPropositionSources(makePlan(f.inputs, f.selection));
  const scope = sources.input.sources[0].scopes[0];
  sources.facts.push({ ...fact("fixture"), scope: scope.id, claimNo: scope.selected });
  const before = JSON.stringify(sources), output = closedFactInput(sources);
  expect(JSON.stringify(sources)).toBe(before);
  const row = output.find(r => r.scope === scope.id)!;
  const candidate = row.claims.flatMap(c => c.facts).find(f => f.id === "fixture")!;
  expect(candidate.sentence).toContain("駆動機を起動する際・起動後の所定期間");
  expect(candidate.sentence).toContain("青弁の開度を所定値に維持する");
  expect(candidate.basis).toEqual([[0, 30]]);
  scope.nodes.find(n => n.claimNo === scope.selected)!.guaranteed = [999];
  expect(closedFactInput(sources).find(r => r.scope === scope.id)!.closed).toBe(false);
});

it("guides single relation support without prohibiting typed path/set evidence", () => {
  const relation = fact("matching"), route: SourceProposition = { ...relation, id: "route", meaning: {
    kind: "path", subject: "配管", context: "operation", guard: meaning.guard, polarity: "positive",
    origin: "入口", destination: "出口", via: ["青弁"], bypass: [], extent: "whole", relation: "route" } };
  const input = { sourcePropositions: [relation, route] } as PropositionTargetInput;
  expect(reviewSupportInput(input).map(r => r.supportSelection)).toEqual([
    "single_fact_same_subject_context_guard_predicate_objects", "typed_existing_multi_fact_rules_no_unrelated_facts"]);
  expect(reviewSupportInput(input)[0].guard.conditions).toEqual(["駆動機を起動する際", "起動後の所定期間"]);
  expect(reviewSupportInput(input)[0].contraryEvidence).toContain("retain_existing_contradiction");
});

it("keeps normal single-fact maintenance accepted and rejects missing conditions, changed action and unrelated support", () => {
  const own = fact("matching"), other = { ...fact("unrelated"), meaning: { ...meaning, context: "capability" as const } };
  const target: TargetProposition = { id: "t", targetId: "21:1:1:common", span: [0, 30],
    scope: "base:1", claimNo: 1, sourceIds: ["matching"], meaning };
  expect(compareProposition(target, [own]).relation).toBe("entailed");
  expect(compareProposition({ ...target, sourceIds: ["matching", "unrelated"] }, [own, other]).relation).toBe("unresolved");
  expect(compareProposition({ ...target, meaning: { ...meaning, guard: { relation: "when", conditions: ["駆動機を起動する際"] } } }, [own]).relation).toBe("unresolved");
  expect(compareProposition({ ...target, meaning: { ...meaning, predicate: "opens" } }, [own]).relation).not.toBe("entailed");
  expect(compareProposition({ ...target, claimNo: 2 }, [own]).relation).not.toBe("entailed");
});

it("offers exact owner and guard choices, separate claims, and no shortening or borrowed actor", () => {
  const f=fictionalInputs(), sources=canonicalPropositionSources(makePlan(f.inputs,f.selection));
  const scope=sources.input.sources[0].scopes[0];
  scope.nodes.find(n=>n.claimNo===scope.selected)!.guaranteed=[1,2];
  const parent={...fact("parent"),scope:scope.id,claimNo:1,meaning:{...meaning,
    guard:{relation:"when" as const,conditions:["前記駆動機が動作する際","当該駆動機の停止後も"]}}};
  const child={...fact("child"),scope:scope.id,claimNo:2,meaning:{...meaning,
    guard:{relation:"when" as const,conditions:["逆流防止制御を開始する際"]}}};
  const owner={...parent,id:"owner",meaning:{...meaning,subject:"冷媒回路",context:"capability" as const,
    guard:{relation:"unconditional" as const,conditions:[]},predicate:"has" as const,objects:["圧縮機","青色弁"]}};
  sources.facts.push(parent,child,owner,{...parent,id:"long",meaning:{...meaning,objects:["長い原文".repeat(50)]}},
    {...parent,id:"actorless",meaning:{...meaning,subject:null}});
  const rows=closedFactInput(sources).find(r=>r.scope===scope.id)!.claims.flatMap(c=>c.facts);
  const pick=(id:string)=>rows.find(r=>r.id===id)!;
  expect(pick("parent").sentence).toContain("前記駆動機が動作する際・当該駆動機の停止後も");
  expect(pick("parent").meaning).toEqual(parent.meaning);
  expect([pick("child").id]).toEqual(["child"]);
  expect(pick("child").claimNo).toBe(2);
  expect(pick("child").meaning.guard).toEqual(child.meaning.guard);
  expect(pick("owner").sentence).toBe("機能・構成として、冷媒回路は圧縮機・青色弁を備える。");
  expect((pick("long").sentence!.length <= 120)).toBe(false);
  expect(pick("long").sentence).toContain("長い原文".repeat(50));
  expect(pick("actorless").meaning.subject).toBe(null);
});

it("offers common pairs only for exact typed facts on opposite sides", () => {
  const f=fictionalInputs(), sources=canonicalPropositionSources(makePlan(f.inputs,f.selection));
  const base=sources.input.sources[0].scopes[0], candidate=sources.input.sources[1].scopes[0];
  const b={...fact("exact-base"),scope:base.id,claimNo:base.selected};
  const c={...b,id:"exact-candidate",scope:candidate.id,claimNo:candidate.selected};
  sources.facts.push(b,c,{...c,id:"optional-parent",claimNo:999},
    {...c,id:"wrong-owner",meaning:{...meaning,subject:"別制御器"}},
    {...c,id:"missing-condition",meaning:{...meaning,guard:{relation:"unconditional" as const,conditions:[]}}});
  const pairs=closedFactInput(sources).find(r=>r.scope===candidate.id)!.commonFactPairs;
  expect(pairs.filter(x=>x.baseIds.includes("exact-base"))).toEqual([{baseScope:base.id,candidateScope:candidate.id,baseIds:["exact-base"],candidateIds:["exact-candidate"]}]);
  expect(closedFactInput(sources).find(r=>r.scope===base.id)!.commonFactPairs).toEqual([]);
});
it("preserves all original rendered sentences and scope closure, including set/path/null actors", () => {
  const f=fictionalInputs(), sources=canonicalPropositionSources(makePlan(f.inputs,f.selection));
  const scope=sources.input.sources[0].scopes[0];
  sources.facts.push({...fact("null-actor"),scope:scope.id,claimNo:scope.selected,meaning:{...meaning,subject:null}},
    {...fact("set"),scope:scope.id,claimNo:scope.selected,meaning:{kind:"set",subject:"装置",context:"capability",
      guard:{relation:"unconditional",conditions:[]},polarity:"positive",selection:"required",extent:"closed",members:["青弁","赤弁"]}},
    {...fact("path"),scope:scope.id,claimNo:scope.selected,meaning:{kind:"path",subject:null,context:"operation",
      guard:meaning.guard,polarity:"positive",origin:"入口",via:["青弁"],destination:"出口",bypass:[],extent:"whole",relation:"route"}});
  const before=JSON.stringify(sources), result=closedFactInput(sources);
  for(const row of result)for(const claim of row.claims)for(const fact of claim.facts){
    let expected:string|null=null;try{expected=`${renderMeaning(fact.meaning)}。`;}catch{}
    expect(fact.sentence).toBe(expected);
  }
  const row=result.find(r=>r.scope===scope.id)!;
  expect(row.closed).toBe(row.claims.length>0&&row.claims.every(c=>c.original!==null&&c.facts.length>0&&c.facts.every(f=>f.sentence!==null)));
  expect(JSON.stringify(sources)).toBe(before);
});
