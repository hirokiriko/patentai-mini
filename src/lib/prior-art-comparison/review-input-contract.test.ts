import { expect, it } from "vitest";
import { compareProposition, type Meaning, type SourceProposition, type TargetProposition } from "./propositions";

// Synthetic input-contract examples, not repaired case99 responses or acceptance.
const meaning: Meaning = { kind: "relation", subject: "制御器", context: "operation",
  guard: { relation: "when", conditions: ["青弁を開いて駆動機を運転中に停止する際", "停止した後も"] },
  polarity: "positive", predicate: "maintains", objects: ["青弁の開いた状態を維持する"] };
const source = (id: string, m: Meaning, scope = "candidate:7:1", claimNo = 1): SourceProposition =>
  ({ id, scope, claimNo, basis: [[10, 90]], meaning: m, authority: "extracted" });
const target = (m: Meaning, ids = ["own"]): TargetProposition =>
  ({ id: "t", targetId: "7:1:1:common", span: [0, 70], scope: "candidate:7:1", claimNo: 1, sourceIds: ids, meaning: m });

it("accepts independently extracted complete maintained state but preserves missing-condition and wrong-document rejection", () => {
  const own = source("own", meaning), before = JSON.stringify(own);
  expect(compareProposition(target(structuredClone(meaning)), [own]).relation).toBe("entailed");
  expect(compareProposition(target({ ...meaning, guard: { relation: "when", conditions: [meaning.guard.conditions[0]] } }), [own]).relation).toBe("unresolved");
  expect(compareProposition(target({ ...meaning, predicate: "opens" }), [own]).relation).toBe("unresolved");
  expect(compareProposition(target(meaning), [source("own", meaning, "candidate:8:1")]).relation).toBe("unresolved");
  expect(compareProposition(target(meaning), [source("own", meaning, "candidate:7:1", 2)]).relation).toBe("unresolved");
  expect(JSON.stringify(own)).toBe(before);
});

it("does not turn a has relation into a set or invent an unlisted controller from another action", () => {
  const has: Meaning = { kind: "relation", subject: "空調装置", context: "capability",
    guard: { relation: "unconditional", conditions: [] }, polarity: "positive", predicate: "has", objects: ["圧縮機", "冷媒回路"] };
  const own = source("own", has);
  expect(compareProposition(target(has), [own]).relation).toBe("entailed");
  expect(compareProposition(target({ ...has, objects: ["圧縮機", "制御器"] }), [own]).relation).toBe("unresolved");
  const set: Meaning = { kind: "set", subject: has.subject, context: has.context, guard: has.guard,
    polarity: "positive", selection: "required", extent: "partial", members: ["圧縮機", "制御器"] };
  expect(compareProposition(target(set), [own]).relation).toBe("unresolved");
  expect(compareProposition(target(has, ["action"]), [source("action", meaning)]).relation).toBe("unresolved");
});

it("keeps parent and child assertions separate instead of combining their guards or claim labels", () => {
  const child = source("own", meaning, "candidate:7:1", 1);
  expect(compareProposition(target({ ...meaning, subject: "請求項1の制御器" }), [child]).relation).toBe("unresolved");
  expect(compareProposition(target({ ...meaning, guard: { relation: "when", conditions: [...meaning.guard.conditions, "親モードの回転数が閾値以下"] } }), [child]).relation).toBe("unresolved");
});