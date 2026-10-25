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
it.each(["であることを特徴とする装置。","である。","であり、青弁を備える。","を実行すると共に、停止中は青弁を閉じる。"])("retains completed reduction in an asserted mode definition: %s",ending=>{
 expect(read(`気体を減圧した後、白吸熱器にて吸熱させる冷却モード${ending}`)).toContainEqual({kind:"executes",literal:"減圧した"});
});

it("requires separate active occurrences beside heat and mode-owned paths", () => {
 const tasks=read("制御器により、液を青放熱器にて放熱させ、液を槽に流す冬モードと、液を白吸熱器にて吸熱させ、液を槽に流し、槽から源に吸い込ませる夏モードを切り換えて実行する装置。");
 for(const literal of ["放熱させ","流す","吸熱させ","流し","吸い込ませる"])
  expect(tasks).toContainEqual({kind:"executes",literal});
 expect(tasks).toContainEqual({kind:"releases_heat",literal:"放熱させ"});
 expect(tasks).toContainEqual({kind:"absorbs_heat",literal:"吸熱させ"});
 const generated=read("制御器により、補助加熱装置を発熱させる除湿暖房モードを実行する装置。");
 expect(generated).toContainEqual({kind:"generates_heat",literal:"発熱させ"});
 expect(generated).toContainEqual({kind:"executes",literal:"発熱させ"});
});

it("retains active transfers into numbered modes without admitting a purpose definition",()=>{
 const tasks=read("制御器により、液を槽に流す第１の運転モードと、槽から源に吸い込ませる第２の運転モードを切り換えて実行する装置において、停止中は表示する。");
 expect(tasks).toContainEqual({kind:"executes",literal:"流す"});
 expect(tasks).toContainEqual({kind:"executes",literal:"吸い込ませる"});
 expect(read("液を槽に流すための弁を備え、第１の運転モードを実行する装置。").some(t=>t.kind==="executes"&&t.literal==="流す")).toBe(false);
});

it.each([
 "液を槽に流すための弁と、液を吸熱させる夏モードを実行する装置。",
 "液を吸熱させない夏モードである。",
 "液を吸熱させることなく槽へ送る夏モードである。",
 "液を槽に流す必要がない夏モードである。",
 "液を槽に流すことを禁止する夏モードである。",
 "液を槽に流した場合、警報する夏モードである。",
 "液を槽に流し、異常の場合は停止する夏モードである。",
 "液を槽に流し、源に吸い込ませる夏モードの場合に停止する。",
 "液を槽に流し、源に吸い込ませる夏モードを実行するとは限らない。",
 "液を槽に流し、源に吸い込ませる夏モード。",
 "槽に接続された管と、箱に設けられた弁を備える。",
])("does not promote a definition, premise, negation or passive into a mode action: %s", text=>{
 const tasks=read(text).filter(t=>t.kind==="executes");
 expect(tasks.some(t=>["流す","流し","吸い込ませる"].includes(t.literal))).toBe(false);
 if(!text.includes("ための"))expect(tasks.some(t=>t.literal==="吸熱させ")).toBe(false);
});
