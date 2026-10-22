import { expect, it } from "vitest";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { propositionSourceInput, decodeSourcePropositions } from "./proposition-extraction";
import { sourceReadingClaim } from "./source-clause-coverage";
import { SOURCE_CLAUSE_ACTION_EXAMPLE } from "./source-clause-prompt";
import { propositionSourceClauseTransport, resolveSourceClauseQuote, sourceClausePropositionModelSchemaFor } from "./source-clause-wire";
import { fixtureClauseWire, fixtureDeclareClauseReading } from "../../../scripts/prior-art-clause-fixture.mjs";

function setup(text = SOURCE_CLAUSE_ACTION_EXAMPLE.clauses.map(c => c[1]).join(""), fact: unknown = SOURCE_CLAUSE_ACTION_EXAMPLE.fact) {
  const f = fictionalInputs(), source = "【請求項1】" + text;
  f.inputs.draft = parseComparisonSource(source, 11, "架空");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource(source, d.id, "架空"));
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan);
  const wire = { v: 15, s: input.sources.map(s => ({ d: s.sourceDigest, c1: [structuredClone(fact)] })) };
  return { plan, input, wire, model: sourceClausePropositionModelSchemaFor(plan) };
}
const firstFact = (wire: ReturnType<typeof setup>["wire"]) => wire.s[0].c1[0] as Record<string, unknown>;

it("decodes the fictional conditional maintenance example and preserves the raw answer", async () => {
  const f = setup(), before = JSON.stringify(f.wire), result = await f.model.validate!(f.wire);
  expect(result.success).toBe(true);
  if (result.success) expect(() => decodeSourcePropositions(f.plan, result.value)).not.toThrow();
  expect(JSON.stringify(f.wire)).toBe(before);
  const claims = propositionSourceClauseTransport(f.input).sources[0].source.claims;
  expect(claims[0].clauses).toEqual(SOURCE_CLAUSE_ACTION_EXAMPLE.clauses);
  expect(claims[0]).not.toHaveProperty("grid");
  expect(claims[0].clauses.map(c => c[1]).join("")).toBe(SOURCE_CLAUSE_ACTION_EXAMPLE.clauses.map(c => c[1]).join(""));
});

it("resolves only the selected clause and disambiguates exact adjacent context", () => {
  const c = sourceReadingClaim(1, "赤弁と青弁と赤弁。赤弁を閉じる。");
  expect(() => resolveSourceClauseQuote(c, "0:赤弁")).toThrow();
  const span = resolveSourceClauseQuote(c, ["0", "赤弁", "青弁と", "。"]);
  expect(c.grid.text.slice(...span)).toBe("赤弁");
  expect(span[0]).toBe(6);
  expect(resolveSourceClauseQuote(c, "1:赤弁")[0]).toBe(9);
  expect(() => resolveSourceClauseQuote(c, "0:閉じる")).toThrow();
  expect(() => resolveSourceClauseQuote(c, ["0", "赤弁", "不存在", ""])).toThrow();
});

it("keeps Unicode scalars, combining characters, spaces and quote colons exact", () => {
  const c = sourceReadingClaim(1, "装置😀とe\u0301と A:B を備える。");
  for (const value of ["0:😀", "0:e\u0301", "0: A:B "]) {
    const span = resolveSourceClauseQuote(c, value);
    expect(c.grid.text.slice(...span)).toBe(value.slice(2));
  }
  expect(() => resolveSourceClauseQuote(c, "0:é")).toThrow();
  expect(() => resolveSourceClauseQuote(c, "0:\ud83d")).toThrow();
  expect(() => resolveSourceClauseQuote(c, "0:\ude00")).toThrow();
});

it.each(["", "0:", "01:弁", "-1:弁", "1.5:弁", "99:弁", ["0", "", "", ""], ["0", "弁"], ["0", "弁", "", "", "extra"], [0, "弁", "", ""]].map(value => ({value})))(
  "rejects malformed or unavailable clause quotes: $value", ({value}) => {
    expect(() => resolveSourceClauseQuote(sourceReadingClaim(1, "弁を開く。"), value)).toThrow();
  });

it.each(["top_key", "source_key", "fact_key", "meaning_key", "Y", "unresolved", "empty_claim", "missing_claim", "wrong_source", "legacy", "empty_W", "duplicate_W", "unknown_W", "fraction_W", "string_W", "empty_term", "wrong_clause", "disjoint_proof", "reverse_proof", "duplicate_proof", "unknown_proof", "unknown_frame"])(
  "rejects v15 padding, incompatible answers or invalid evidence: %s", async mode => {
    const f = setup(), fact = firstFact(f.wire), meaning = fact.m as Record<string, unknown>;
    const root = f.wire as unknown as Record<string, unknown>, source = f.wire.s[0] as unknown as Record<string, unknown>;
    if (mode === "top_key") root.extra = true;
    if (mode === "source_key") source.extra = true;
    if (mode === "fact_key") fact.extra = true;
    if (mode === "meaning_key") meaning.extra = true;
    if (mode === "Y") source.Y = [["c1:0"]];
    if (mode === "unresolved") source.c1 = { K: [0], N: "unresolved" };
    if (mode === "empty_claim") source.c1 = [];
    if (mode === "missing_claim") delete source.c1;
    if (mode === "wrong_source") source.d = f.wire.s[1].d;
    if (mode === "legacy") root.v = 14;
    if (mode === "empty_W") fact.W = [];
    if (mode === "duplicate_W") fact.W = [0, 1, 2, 2];
    if (mode === "unknown_W") fact.W = [0, 1, 3];
    if (mode === "fraction_W") fact.W = [0, 1, 2.5];
    if (mode === "string_W") fact.W = ["0", 1, 2];
    if (mode === "empty_term") meaning.u = [];
    if (mode === "wrong_clause") meaning.u = ["2:制御器"];
    if (mode === "disjoint_proof") fact.O = [null, null, null, [0, 2], [0, 1, 2]];
    if (mode === "reverse_proof") fact.O = [null, null, null, [2, 1], [0, 1, 2]];
    if (mode === "duplicate_proof") fact.O = [null, null, null, [1, 1], [0, 1, 2]];
    if (mode === "unknown_proof") fact.O = [null, null, null, [99], [0, 1, 2]];
    if (mode === "unknown_frame") fact.F = 999;
    expect((await f.model.validate!(f.wire)).success).toBe(false);
  });

it("rejects a technically unrepresented clause rather than generating a Y placeholder", async () => {
  const f = setup(SOURCE_CLAUSE_ACTION_EXAMPLE.clauses.map(c => c[1]).join("") + "補助器を備える。");
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("retains the existing whole-claim shorthand only in proof positions", async () => {
  const f = setup();
  firstFact(f.wire).O = [null, null, null, [1], []];
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  (firstFact(f.wire).m as Record<string, unknown>).u = [[]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("preserves conjunctive negative and threshold conditions through the existing decoder", async () => {
  const fact = structuredClone(SOURCE_CLAUSE_ACTION_EXAMPLE.fact);
  fact.m.G = [["1:非通電状態"], ["1:温度が七度を超える場合"]];
  const f = setup("制御器は、非通電状態で温度が七度を超える場合、弁開度を大きい値に維持する。", fact);
  const result = await f.model.validate!(f.wire);
  expect(result.success).toBe(true);
  if (result.success) expect(() => decodeSourcePropositions(f.plan, result.value)).not.toThrow();
  (firstFact(f.wire).m as Record<string, unknown>).G = [["1:通電状態"], ["1:温度が七度を超える場合"]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("binds a postposed actor to its actual clause without borrowing another occurrence", async () => {
  const fact = { m: { u: ["1:制御器"], x: 1, g: 1, G: [["0:起動後の間"]], p: 0, k: 2, P: 10,
    J: [["1:弁開度を大きい値に維持する"]] }, O: [null, null, null, [0], [0, 1]], F: null, W: [0, 1] };
  const f = setup("起動後の間、弁開度を大きい値に維持する制御器。", fact);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  firstFact(f.wire).W = [0];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("requires every conjunctive condition to fit inside the selected guard proof", async () => {
  const fact = { m: { u: ["0:制御器"], x: 1, g: 1, G: [["1:非通電状態"], ["2:温度が七度を超える場合"]],
    p: 0, k: 2, P: 10, J: [["3:弁開度を大きい値に維持する"]] },
    O: [null, null, null, [1, 2], [0, 1, 2, 3]], F: null, W: [0, 1, 2, 3] };
  const f = setup("制御器は、非通電状態で、温度が七度を超える場合、弁開度を大きい値に維持する。", fact);
  expect((await f.model.validate!(f.wire)).success).toBe(true);
  firstFact(f.wire).O = [null, null, null, [1], [0, 1, 2, 3]];
  expect((await f.model.validate!(f.wire)).success).toBe(false);
});

it("keeps exact cross-clause operator spans through the independent fictional fixture", async () => {
  const fact = { m: { u: ["0:制御器"], x: 1, g: 1, G: [["1:非通電状態"], ["2:温度が七度を超える場合"]],
    p: 0, k: 2, P: 10, J: [["3:弁開度を大きい値に維持する"]] },
    O: [null, null, null, ["1", "2", "前記非通電状態で、温度が七度を超える場合", "", "、"], []], F: null, W: [0, 1, 2, 3] };
  const f = setup("制御器は、前記非通電状態で、温度が七度を超える場合、弁開度を大きい値に維持する。", fact);
  const initial = await f.model.validate!(f.wire);
  expect(initial.success).toBe(true);
  if (!initial.success) return;
  const before = JSON.stringify(initial.value), input = propositionSourceClauseTransport(f.input);
  fixtureDeclareClauseReading(initial.value, input);
  expect(JSON.stringify(initial.value)).toBe(before);
  const wire = fixtureClauseWire(initial.value, input);
  expect(wire.s[0].c1[0].O[3]).toEqual(["1", "2", "前記非通電状態で、温度が七度を超える場合", "", "、"]);
  expect(wire.s[0].c1[0].O[4]).toEqual([]);
  const restored = await f.model.validate!(wire);
  expect(restored).toEqual(initial);
});

it.each([{key:"x",value:2},{key:"g",value:3},{key:"p",value:2},{key:"e",value:4},{key:"S",value:4}])(
  "rejects uncertainty padding in meaning field $key", async ({key,value}) => {
    const f = setup();
    expect((await f.model.validate!(f.wire)).success).toBe(true);
    (firstFact(f.wire).m as Record<string,unknown>)[key] = value;
    expect((await f.model.validate!(f.wire)).success).toBe(false);
  });

it("allows the existing mandatory loop to answer its claim without a fabricated additional fact", async () => {
  const text = "前記分岐器から出た気体を、前記冷却器を経ること無く前記蓄積器に流すための第２の開閉弁と、" +
    "前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、前記送出器から吐出された気体を前記加熱器に流し、" +
    "前記分岐器から前記バイパス配管を通って前記蓄積器に流し、前記送出器に吸い込ませる第１の運転モードと、" +
    "別経路を実行する第２の運転モードを切り換える。";
  const f = setup(text), input = propositionSourceClauseTransport(f.input);
  const wire = {v:15,s:input.sources.map((s,i)=>{
    expect(s.recognizedLoopRoutes).toHaveLength(1);
    const r = f.input.sources[i].recognizedLoopRoutes[0];
    return {d:s.sourceDigest,c1:[],loop0:{n:1,b:{a:r.basisParts[0],z:r.basisParts[1]},
      m:{u:["6:第１の運転モード"],x:1,g:0,G:[],p:0,k:1,i:["4:送出器"],j:["6:送出器"],
        V:[["4:加熱器"],["5:分岐器"],["5:バイパス配管"],["5:蓄積器"]],B:[["1:冷却器"]],e:3,r:0},
      O:[null,null,null,null,[]],F:0,W:s.source.claims[0].clauses.map(c=>c[0])}};
  })};
  expect((await f.model.validate!(wire)).success).toBe(true);
  delete (wire.s[0] as Record<string,unknown>).loop0;
  expect((await f.model.validate!(wire)).success).toBe(false);
});
