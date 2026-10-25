import { expect, it } from "vitest";
import { sourceReadingClaim } from "./source-clause-coverage";
import { sourceCausalModeGuards, assertSourceCausalModeGuards } from "./source-causal-mode-guards";
import type { Span } from "./propositions";

// Fictional source only. No provider answer is repaired or used as a fixture.
const text = "制御器により、青弁を閉じ、赤弁を開くことで、液を放熱器で放熱させ、液を減圧した後、交換器で吸熱させ、槽へ流し、源に吸い込ませる第１の運転モードと、青弁を開き、赤弁を閉じることで、液を槽へ流し、源に吸い込ませる第２の運転モードを切り換えて実行する装置。制御器は、起動後の所定期間、開度を維持する。";
const span = (literal: string, after = 0): Span => {
  const at = text.indexOf(literal, after); if (at < 0) throw new Error("fixture");
  return [at, at + literal.length];
};
const causes = sourceCausalModeGuards(sourceReadingClaim(1, text));
const fact = (action = span("放熱させ")) => ({ kind: "relation", action, route: [] as Span[], guard: causes[0].controls.map(s => [s]) });

it("locates both complete coordinated causes and stops before each printed mode name", () => {
  expect(causes.map(c => c.controls.map(s => text.slice(...s)))).toEqual([
    ["青弁を閉じ", "赤弁を開くことで"], ["青弁を開き", "赤弁を閉じることで"],
  ]);
  expect(causes.map(c => text.slice(...c.effect))).toEqual([
    "液を放熱器で放熱させ、液を減圧した後、交換器で吸熱させ、槽へ流し、源に吸い込ませる",
    "液を槽へ流し、源に吸い込ませる",
  ]);
});
it.each(["放熱させ", "減圧した", "吸熱させ", "流し", "吸い込ませる"])("retains complete causal guards for the actual action occurrence %s", action => {
  const f = fact(span(action)), before = JSON.stringify(f);
  expect(() => assertSourceCausalModeGuards(causes, f)).not.toThrow();
  expect(JSON.stringify(f)).toBe(before);
  expect(() => assertSourceCausalModeGuards(causes, { ...f, guard: [] })).toThrow("causal_guard_incomplete");
});
it.each([0, 1])("rejects either missing cause without filling it: %s", missing => {
  const f = fact(); f.guard.splice(missing, 1); const before = JSON.stringify(f);
  expect(() => assertSourceCausalModeGuards(causes, f)).toThrow();
  expect(JSON.stringify(f)).toBe(before);
});
it("rejects bare objects, incomplete connectors and a different occurrence", () => {
  for (const guard of [[[span("青弁")], [causes[0].controls[1]]],
    [[causes[0].controls[0]], [span("赤弁を開く")]], causes[1].controls.map(s => [s])])
    expect(() => assertSourceCausalModeGuards(causes, { ...fact(), guard })).toThrow();
});
it("accepts a complete joint quote or contiguous exact spans, never a gap", () => {
  const [a, b] = causes[0].controls;
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(), guard: [[[a[0], b[1]]]] })).not.toThrow();
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(), guard: [[[a[0], a[0] + 2], [a[0] + 2, a[1]]], [b]] })).not.toThrow();
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(), guard: [[[a[0], a[0] + 2], [a[0] + 3, a[1]]], [b]] })).toThrow();
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(), guard: [[[a[0] + 2, a[1]], [a[0], a[0] + 2]], [b]] })).toThrow();
});
it("checks paths and whole loops from their actual route quotes, not control-frame evidence", () => {
  const path = { ...fact(), kind: "path", action: null, route: [span("放熱器"), span("源")] };
  expect(() => assertSourceCausalModeGuards(causes, path)).not.toThrow();
  expect(() => assertSourceCausalModeGuards(causes, { ...path, guard: [] })).toThrow();
});
it("does not make the valve actions conditional on themselves, or leak into switching and maintenance", () => {
  for (const literal of ["閉じ", "開く", "切り換えて実行する", "維持する"])
    expect(() => assertSourceCausalModeGuards(causes, { ...fact(span(literal)), guard: [] })).not.toThrow();
});
it("requires the second mode's own causes and checks its return before the same-clause switch", () => {
  const action = span("吸い込ませる", causes[1].effect[0]);
  expect(() => assertSourceCausalModeGuards(causes, fact(action))).toThrow();
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(action), guard: causes[1].controls.map(s => [s]) })).not.toThrow();
  const broadSwitch: Span = [action[0], span("切り換えて実行する")[1]];
  // Passing this partial checker does not prove a cross-scope assertion correct.
  expect(() => assertSourceCausalModeGuards(causes, { ...fact(broadSwitch), guard: [] })).not.toThrow();
});
it.each([
  "青弁を閉じ、赤弁を開くことでない。",
  "青弁を閉じ、赤弁を開く場合、液を流す冬モードと、",
  "青弁を閉じ、赤弁を開くための弁。",
  "青弁を閉じ、赤弁を開くことで、液を流す冬モードの場合、",
  "青弁を閉じ、赤弁を開くことで、液を流す冬モードを実行しない装置。",
  "青弁を閉じ、赤弁を開くことで、新制御器は、液を流す冬モードと、",
  "青弁を閉じ、赤弁を開くことで、新制御器が液を流す冬モードと、",
  "青弁を閉じ、赤弁を開くことで、新制御器により、液を流す冬モードと、",
  "青弁を閉じ、赤弁を開くことで、液を流すための装置の冬モードと、",
  "青弁を閉じ、赤弁を開くことで、液を流さない冬モードと、",
  "赤弁を開くことで、液を流す冬モードと、",
])("leaves ambiguous or nonasserted syntax to full original QA: %s", original => {
  expect(sourceCausalModeGuards(sourceReadingClaim(1, original))).toEqual([]);
});
