import { describe, expect, it } from "vitest";
import { isLiteralSourceState } from "./literal-source-state";
import { renderMeaning } from "./proposition-result";
import { compareProposition, meaningSchema, type Meaning, type SourceProposition, type TargetProposition } from "./propositions";
import { decodeSourcePropositions, propositionSourceInput } from "./proposition-extraction";
import { fictionalInputs } from "./fixtures.test-support";
import { makePlan } from "./comparison";
import { parseComparisonSource } from "./source";
import { sourceCompleteActionCues } from "./source-semantic-check";
import { sourceReadingClaim } from "./source-clause-coverage";

type Relation = Extract<Meaning, { kind: "relation" }>;
const guard = { relation: "unconditional" as const, conditions: [] };
const state = (phrase = "電源が供給される", subject: string | null = "制御器"): Relation =>
  ({ kind: "relation", predicate: "is_state", subject, objects: [phrase], context: "operation", guard, polarity: "positive" });
const source = (meaning: Meaning): SourceProposition =>
  ({ id: "s1", scope: "base:1", claimNo: 1, basis: [[0, 40]], meaning, authority: "extracted" });
const target = (meaning: Meaning): TargetProposition =>
  ({ id: "t1", targetId: "1:1:1:common", span: [0, 40], sourceIds: ["s1"], scope: "base:1", claimNo: 1, meaning });

function literalSource(phrase: string) {
  const f = fictionalInputs(), text = `制御器は、${phrase}。`;
  f.inputs.draft = parseComparisonSource("【請求項1】" + text, 11, "架空");
  f.inputs.documents = f.inputs.documents.map(d => parseComparisonSource("【請求項1】" + text, d.id, "架空"));
  const plan = makePlan(f.inputs, f.selection), input = propositionSourceInput(plan);
  const raw = { sources: input.sources.map(s => {
    const claim = s.source.claims[0], body = claim.segments.map(p => p.text).join("");
    const span = (term: string): [number, number] => {
      const start = body.indexOf(term);
      if (start < 0) throw Error("Fixture term is absent from the original claim");
      return [start, start + term.length];
    };
    return { sourceDigest: s.sourceDigest, facts: [{ claimNo: 1, basis: [[0, body.length]], meaning: state(phrase),
      bindings: ["制御器", phrase].map(term => ({ term, spans: [span(term)] })),
      operators: { selection: null, extent: null, polarity: null, guard: null, context: null }, routeFrame: null }] };
  }) };
  return { plan, raw };
}

describe("literal passive states (fictional fixtures, not AI quality)", () => {
  it.each(["箱の外に設けられた", "入口と出口の間に設けられる"])("preserves exact passive placement without inventing inside/upstream: %s", phrase => {
    const f=literalSource(phrase),before=JSON.stringify(f.raw);
    const decoded=decodeSourcePropositions(f.plan,f.raw);
    expect(JSON.stringify(f.raw)).toBe(before);
    const fact=decoded.facts.find(p=>p.scope==="base:1")!;
    expect(fact.meaning).toEqual(state(phrase));
    expect(renderMeaning(fact.meaning)).toContain(`「${phrase}」`);
    const assertion={...target(state(phrase)),sourceIds:[fact.id]};
    expect(compareProposition(assertion,decoded.facts).relation).toBe("entailed");
    for(const changed of [state("箱の内に設けられた"),{...state(phrase),predicate:"inside" as const,objects:["箱"]},
      {...state(phrase),predicate:"upstream" as const,objects:["入口"]}])
      expect(compareProposition({...assertion,meaning:changed},decoded.facts).relation).toBe("unresolved");
  });
  it.each(["設けられた","箱に設ける","箱に設けられない","箱に設けられた場合","箱に設けられたが弁を開く","弁が開けば箱の外に設けられた","弁を開き箱の外に設けられた"])("rejects missing location, active action or conditional placement: %s", phrase=>{
    expect(isLiteralSourceState(phrase)).toBe(false);
    const f=literalSource(phrase);expect(()=>decodeSourcePropositions(f.plan,f.raw)).toThrow();
  });
  it("does not hide a preceding valve action inside a placement state cue",()=>{
    const claim=sourceReadingClaim(1,"赤弁を開き、箱の外に設けられた。");
    const cues=sourceCompleteActionCues(claim);
    expect(cues.some(c=>c.predicate==="opens")).toBe(true);
    expect(cues.filter(c=>c.predicate==="is_state").map(c=>claim.grid.text.slice(...c.span))).toEqual(["箱の外に設けられた"]);
  });
  it.each(["電源が供給され", "電源が供給される", "非通電とされる", "吸込側に接続された", "全閉となり", "閉じた状態に復帰する", "開いた状態に復帰する"])(
    "retains the permitted literal state %s", phrase => {
      expect(isLiteralSourceState(phrase)).toBe(true);
      expect(meaningSchema.parse(state(phrase))).toEqual(state(phrase));
      expect(renderMeaning(state(phrase))).toBe(`運転状態として、制御器について、「${phrase}」という状態である`);
    });

  it.each(["電源供給が絶たれる", "赤弁を閉じる", "青弁を開く", "閉じた状態を維持する", "圧縮機を停止する", "制御を終了する", "電源が供給されるが圧縮機を停止する", "全閉となり閉じた状態を維持する"])(
    "does not disguise an event or maintenance as a passive state: %s", phrase => {
      expect(isLiteralSourceState(phrase)).toBe(false);
      expect(() => renderMeaning(state(phrase))).toThrow();
      const f = literalSource(phrase);
      expect(() => decodeSourcePropositions(f.plan, f.raw)).toThrow();
    });

  it("does not invent an actor for an unattributed state or join multiple states", () => {
    expect(renderMeaning(state("非通電とされる", null))).toBe("運転状態として、「非通電とされる」という状態である");
    expect(() => renderMeaning({ ...state(), objects: ["電源が供給される", "非通電とされる"] })).toThrow();
    const f = literalSource("電源が供給される");
    f.raw.sources[0].facts[0].meaning.objects.push("非通電とされる");
    expect(() => decodeSourcePropositions(f.plan, f.raw)).toThrow();
  });

  it.each(["冷媒を圧縮する", "逆圧防止制御"])("displays the printed execution %s without malformed verb suffixes", phrase => {
    const rendered = renderMeaning({ ...state(), predicate: "executes", objects: [phrase] });
    expect(rendered).toBe(`運転状態として、制御器は「${phrase}」という動作を行う`);
    expect(rendered).not.toContain("するを実行する");
  });

  it("accepts the same source/target state without repairing the source answer", () => {
    const f = literalSource("電源が供給される"), before = JSON.stringify(f.raw);
    const decoded = decodeSourcePropositions(f.plan, f.raw);
    expect(JSON.stringify(f.raw)).toBe(before);
    const fact = decoded.facts.find(p => p.scope === "base:1" && p.meaning.kind === "relation" && p.meaning.predicate === "is_state");
    expect(fact).toBeDefined();
    const assertion = { ...target(state()), sourceIds: [fact!.id] };
    expect(compareProposition(assertion, decoded.facts).relation).toBe("entailed");
    expect(renderMeaning(fact!.meaning)).toBe(renderMeaning(assertion.meaning));
  });

  it("keeps exact state, actor, conditions, context and predicate boundaries", () => {
    const m = state(), facts = [source(m)];
    expect(compareProposition(target(m), facts).relation).toBe("entailed");
    for (const changed of [
      state("非通電とされる"), state("電源が供給される", null),
      { ...m, context: "capability" as const },
      { ...m, guard: { relation: "when" as const, conditions: ["停止時"] } },
      ...(["has", "executes", "maintains", "closes", "power_ends"] as const).map(predicate => ({ ...m, predicate })),
    ]) expect(compareProposition(target(changed), facts).relation).toBe("unresolved");
  });
});
