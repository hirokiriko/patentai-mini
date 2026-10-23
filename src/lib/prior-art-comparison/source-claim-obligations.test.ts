import { expect, it } from "vitest";
import { sourceClaimObligations } from "./source-claim-obligations";
import { sourceReadingClaim } from "./source-clause-coverage";

const read = (text: string) => { const c = sourceReadingClaim(1, text); return sourceClaimObligations(c).map(t => ({ kind: t.kind, literal: text.slice(...t.span) })); };
it("keeps separate literal occurrences for capability and each mode's heat and reduction", () => {
  const text = "気体を放熱させるための青放熱器を備え、気体を前記青放熱器にて放熱させ、前記青減圧弁で減圧した後、白吸熱器にて吸熱させ、気体を容器に流す第１の運転モードと、別の容器へ気体を流す第２の運転モードを切り換えて実行する空調装置において、弁の開度を大きい値に維持することを特徴とする。";
  const tasks = read(text);
  expect(tasks.filter(t => t.kind === "releases_heat")).toHaveLength(2);
  expect(tasks).toContainEqual({kind:"executes",literal:"減圧した"});
  expect(tasks).toContainEqual({kind:"executes",literal:"切り換えて実行する"});
  expect(tasks).toContainEqual({kind:"maintains",literal:"維持する"});
});
it.each([
  "減圧した後に異常を検出した場合、装置を停止する。",
  "減圧した後、気体を流す必要がない運転モード。",
  "冷媒を減圧した後、吸熱させる運転モードの場合に警報を出す。",
  "冷媒を減圧した後、吸熱させる運転モードが必要な場合に警報を出す。",
  "状態を維持する場合、表示する。",
  "状態を維持する必要がない。",
  "状態を維持することを特徴としない。",
  "モードを切り換えて実行することを特徴としない。",
  "状態を維持することを特徴とするとは限らない。",
  "状態を維持することを特徴とするのであれば、表示する。",
  "冷媒を減圧した後、吸熱させる冷却モードであることを特徴とするとは限らない。",
  "冷媒を減圧した後、吸熱させる冷却モードを実行する必要がない。",
  "モードを切り換えて実行することはない。",
  "モードを切り換えて実行するなら、表示する。",
])("does not force an affirmative fact from a condition/negation: %s", text => {
  expect(read(text).some(t=>["減圧した","維持する","切り換えて実行する"].includes(t.literal))).toBe(false);
});
it.each(["であることを特徴とする装置。","である。","であり、青弁を備える。"])("retains completed reduction in an asserted mode definition: %s",ending=>{
 expect(read(`気体を減圧した後、白吸熱器にて吸熱させる冷却モード${ending}`)).toContainEqual({kind:"executes",literal:"減圧した"});
});
