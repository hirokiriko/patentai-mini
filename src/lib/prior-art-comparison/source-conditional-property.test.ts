import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { sourceClaimExtractionPlan, assembleSourceClaims } from "./source-claim-extraction";
import { decodeSourcePropositions } from "./proposition-extraction";

function splitPremiseFixture() {
  const f = fictionalInputs(), sentence = (name: string) => `${name}を停止し、赤弁を閉じたときの、流入側の減圧速度が、流出側の減圧速度よりも速い。`;
  const text = `【請求項1】${sentence("青機")}\n【請求項2】${sentence("白機")}`;
  f.inputs.draft = parseComparisonSource(text, 11, "架空");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(text, d.id, "架空"));
  f.selection.draftClaimNos = [1];
  f.selection.documents = f.selection.documents.map(d => ({ ...d, claimNos: [2] }));
  const chunks = makePlan(f.inputs, f.selection), plan = sourceClaimExtractionPlan(chunks);
  const answers = plan.tasks.map(task => {
    const name = task.claimNo === 1 ? "青機" : "白機";
    return { taskId: task.id, value: {
      v: 34, sourceDigest: task.sourceDigest, claimNo: task.claimNo, d: task.sourceDigest,
      scopes: [{ id: "s0", g: "when", G: [[`0-0:${name}`, "0-0:を停止し"], ["1-1:赤弁", "1-1:を閉じたとき"]],
        proof: `0-1:${name}を停止し、赤弁を閉じたとき` }],
      [`c${task.claimNo}`]: { possessions: [], sets: [], f0: [], f1: [], f2: [], f3: [{ s: "s0",
        m: { u: ["2-2:流入側の減圧速度"], x: "capability", p: "positive", k: "relation", P: "greater_than",
          J: [["3-3:流出側の減圧速度"]], a: "2-3:流入側の減圧速度が、流出側の減圧速度よりも速い" },
        O: [null, null, null, null], F: null }], T: [] },
    } };
  });
  return { chunks, plan, answers };
}

it("assembles split complete premises through the production claim decoder with unchanged original answers", async () => {
  const { chunks, plan, answers } = splitPremiseFixture(), before = JSON.stringify(answers);
  const facts = decodeSourcePropositions(chunks, await assembleSourceClaims(plan, answers)).facts;
  for (const claimNo of [1, 2]) expect(facts.filter(f => f.claimNo === claimNo).some(f =>
    f.meaning.kind === "relation" && f.meaning.predicate === "greater_than" &&
    f.meaning.guard.conditions.includes(`${claimNo === 1 ? "青機" : "白機"}を停止し`))).toBe(true);
  expect(JSON.stringify(answers)).toBe(before);
});

it.each(["gap", "other_claim", "different_terms"])("rejects split premise %s through the production claim decoder", async mode => {
  const { plan, answers } = splitPremiseFixture(), answer = answers[0].value;
  if (mode === "gap") answer.scopes[0].G[0][1] = "0-0:停止し";
  if (mode === "other_claim") answer.scopes[0].G[0][0] = "0-0:白機";
  if (mode === "different_terms") answer.scopes[0].G = [["0-0:青機"], ["0-0:を停止し"], answer.scopes[0].G[1]];
  const before = JSON.stringify(answers);
  expect((await plan.tasks[0].schema.validate!(answer)).success).toBe(false);
  expect(JSON.stringify(answers)).toBe(before);
});

it("keeps a conditional property without inventing an unconditional valve command", async () => {
  const text = "青弁を閉じたときの、流入側の減圧速度が、流出側の減圧速度よりも速い装置。";
  const f = fictionalInputs();
  f.inputs.draft = parseComparisonSource(`【請求項1】${text}`, 11, "架空");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(`【請求項1】${text}`, d.id, "架空"));
  const chunks = makePlan(f.inputs, f.selection), plan = sourceClaimExtractionPlan(chunks);
  const answers = plan.tasks.map(task => ({ taskId: task.id, value: {
    v: 34, sourceDigest: task.sourceDigest, claimNo: 1, d: task.sourceDigest,
    scopes: [{ id: "s0", g: "when", G: [["0-0:青弁を閉じたとき"]], proof: "0-0:青弁を閉じたとき" }],
    c1: { possessions: [], sets: [], f0: [] as unknown[], f1: [], f2: [{ s: "s0",
      m: { u: ["1-1:流入側の減圧速度"], x: "capability", p: "positive", k: "relation", P: "greater_than",
        J: [["2-2:流出側の減圧速度"]], a: "1-2:流入側の減圧速度が、流出側の減圧速度よりも速い" },
      O: [null, null, null, null], F: null }], T: [] },
  } }));
  const original = JSON.stringify(answers);
  const facts = decodeSourcePropositions(chunks, await assembleSourceClaims(plan, answers)).facts;
  expect(facts.filter(fact => fact.meaning.kind === "relation").map(fact => fact.meaning)).toEqual(
    expect.arrayContaining([expect.objectContaining({ context: "capability", predicate: "greater_than",
      guard: { relation: "when", conditions: ["青弁を閉じたとき"] } })]),
  );
  expect(facts.some(fact => fact.meaning.kind === "relation" && fact.meaning.predicate === "closes")).toBe(false);
  expect(JSON.stringify(answers)).toBe(original);
  for (const task of plan.tasks) {
    expect(task.system).toContain("A condition introducing a property is not itself an asserted command");
    expect(JSON.parse(task.prompt).sourceContext.source.claims[0].clauses.map((c: [number, string]) => c[1]).join("")).toBe(text);
  }
  // Reproduce the rejected shape, rather than accepting or repairing its answer.
  const invented = structuredClone(answers[0].value);
  invented.c1.f0.push({ s: null, m: { u: null, x: "operation", p: "positive", k: "relation", P: "closes",
    J: [["0-0:青弁"]], a: "0-0:閉じた" }, O: [null, null, null, null], F: null });
  const rejected = JSON.stringify(invented);
  expect((await plan.tasks[0].schema.validate!(invented)).success).toBe(false);
  expect(JSON.stringify(invented)).toBe(rejected);
});
