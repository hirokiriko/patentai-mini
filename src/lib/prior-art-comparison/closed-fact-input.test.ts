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
