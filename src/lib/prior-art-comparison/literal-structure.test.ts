import { describe, expect, it } from "vitest";
import { compareAttributedStructure, compareLiteralStructure, compileLiteralStructure } from "./literal-structure";

const source = (text: string, claimNo = 8) => ({ claims: [{ claimNo, text, dependsOn: [] }] });
const modes = (fixed = "光", choices = ["音", "振動", "表示"]) =>
  `前記第１の運転モードは${fixed}モードであり、前記第２の運転モードは、${choices.map(n => `${n}モード`).join("と、")}のうちの何れか、又は、それらの組み合わせ、若しくは、それらの全てである。`;
const route = "前記分岐器から出た信号を、前記変換器を経ること無く前記蓄積器に流すための第２の開閉弁と、前記第１の開閉弁を閉じ、前記第２の開閉弁を開くことで、信号を前記蓄積器に流す第１の運転モードと、別経路を実行する第２の運転モードを切り換える。";
const compare = (original: string, target: string) => compareLiteralStructure(source(original), target);

describe("literal source structure (fictional materials only)", () => {
  it("retains full-claim coordinates across any display partition", () => {
    const text = "𠮷の装置を備え、" + modes(), input = source(text);
    const facts = compileLiteralStructure(input);
    expect(facts.modes.map(g => [g[0], text.slice(...g[1]), g[2], g[3].map(s => text.slice(...s))])).toEqual([
      [8, "第１の運転モード", "fixed", ["光モード"]], [8, "第２の運転モード", "choice", ["音モード", "振動モード", "表示モード"]],
    ]);
    for (const group of facts.modes) for (const range of [group[1], ...group[3], group[4]]) expect(text.slice(...range)).not.toContain("\ufffd");
  });
  it.each([
    ["光", ["音", "振動", "表示"]], ["解析", ["記録", "転送"]], ["蛍光", ["光", "音", "振動", "表示", "保存"]],
  ])("computes a counterexample after renaming and changing group size: %s", (fixed, choices) => {
    const findings = compare(modes(fixed, choices), `基準側は${[fixed, ...choices].join("・")}のいずれか/組合せ/全てを対象とする。`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "mandatory_choice", counterexample: [choices[0]] });
    expect(compare(modes(fixed, choices.toReversed()), `第2運転モードは${choices[0]}又は${fixed}のいずれかである。`)).toEqual([]); // unknown member: no inference
  });
  it("finds an omitted member only for an explicitly scoped closed list", () => {
    expect(compare(modes(), "基準側は第2運転モードを音モード又は表示モードのいずれか/全部として許容する。"))
      .toMatchObject([{ kind: "closed_choice", counterexample: ["振動"] }]);
    expect(compare(modes(), "第1運転モードは音又は表示のいずれかである。")).toEqual([]);
    expect(compare(modes(), "第2運転モードは表示・音・振動のいずれかである。")).toEqual([]);
  });
  it.each([
    "基準側は光・音・振動・表示の少なくとも一部を規定する。",
    "基準側は第2運転モードの選択肢として音又は表示のいずれかを含む。",
    "基準側は光モードが必須であり、第2運転モードは音・振動・表示のいずれかである。",
    "光・音・振動・表示のいずれかという誤った要約。",
    "『光・音・振動・表示のいずれか』とは記載していない。",
    "光・音・振動・表示のいずれかではない。",
    "基準側が光・音・振動・表示のいずれかであるとは断定できない。",
    "基準側は光・音・振動・表示のいずれかを対象としない装置も備える。",
    "光・音・振動・表示のいずれかという理解は成立しない。",
    "第2運転モードを選び、表示装置は音又は表示のいずれかである。",
    "光・音・振動・表示のいずれかと同一か要確認。",
    "超光・音・振動・表示のいずれかである。",
    "誤った要約例は「条件を確認する。光・音・振動・表示のいずれかである。ここまで」である。",
  ])("does not reject partial, correct, negated or opaque text: %s", target => expect(compare(modes(), target)).toEqual([]));
  it("does not confuse fixed membership with a legitimate repeated choice", () => {
    expect(compare(modes("光", ["光", "音", "振動"]), "光・音・振動のいずれかである。")).toEqual([]);
    expect(compare("前記第２の運転モードは、光モードと、音モードと、振動モードのうちの何れか、又は、それらの組み合わせ、若しくは、それらの全てである。", "光・音・振動のいずれかである。")).toEqual([]);
  });
  it("does not merge constraints across alternative claims", () => {
    const input = { claims: [...source("前記第１の運転モードは光モードであり、装置を制御する。", 1).claims,
      ...source(modes().split("前記第２")[1].replace(/^/, "前記第２"), 2).claims] };
    expect(compareLiteralStructure(input, "光・音・振動・表示のいずれかである。")).toEqual([]);
  });
  it("binds explicit claim numbers and leaves conflicting alternative definitions opaque", () => {
    const input = { claims: [...source(modes(), 1).claims, ...source(modes("光", ["音", "表示"]), 2).claims,
      { claimNo: 3, text: "請求項1又は2の装置。", dependsOn: [1, 2] }] };
    expect(compareLiteralStructure(input, "基準側の請求項2では第2運転モードは音又は表示のいずれかである。")).toEqual([]);
    expect(compareLiteralStructure(input, "基準側の請求項3では第2運転モードは音又は表示のいずれかである。")).toEqual([]);
    expect(compareLiteralStructure(input, "基準側の請求項1では第2運転モードは音又は表示のいずれかである。"))
      .toMatchObject([{ kind: "closed_choice", claimNo: 1, counterexample: ["振動"] }]);
    expect(compareLiteralStructure(input, "請求項99の第2運転モードは音又は表示のいずれかである。")).toEqual([]);
    expect(compareLiteralStructure(input, "請求項一の第2運転モードは音又は表示のいずれかである。")).toEqual([]);
    for (const number of ["9007199254740992-9007199254740994", "1.2", "1万", "1又は請求項2", "0", "1-2000"]) {
      expect(compareLiteralStructure(input, `請求項${number}の第2運転モードは音又は表示のいずれかである。`)).toEqual([]);
    }
  });
  it.each(["場合に限り装置を動作させる。", "とは限らない。", "という理解は誤りである。"])("does not truncate a postfixed source condition: %s", tail => {
    expect(compileLiteralStructure(source(modes().replace("全てである。", `全てである${tail}`))).modes.some(g => g[2] === "choice")).toBe(false);
  });
  it("does not project an earlier coordinated fixed mode under a postposed condition", () => {
    expect(compileLiteralStructure(source(modes().replace("全てである。", "全てである場合に限り装置を動作させる。"))).modes).toEqual([]);
  });
  it("does not flatten nested modes or accept a postposed exclusion", () => {
    const nested = modes("光", ["表示", "記録"]).replace("は、表示", "は、音モードと、振動モードとの切替を行う表示");
    expect(compileLiteralStructure(source(nested)).modes.some(g => g[2] === "choice")).toBe(false);
    expect(compare(nested, "第2運転モードは表示又は記録のいずれかである。")).toEqual([]);
    expect(compileLiteralStructure(source(modes().replace("全てである。", "全てであることを特徴とする装置を除く。"))).modes.some(g => g[2] === "choice")).toBe(false);
  });
  it.each(["ただし条件を満たす場合、", "例えば", "「"])("leaves conditional or quoted grammar opaque: %s", prefix => {
    const text = modes().replace("は、音", `は、${prefix}音`);
    expect(compileLiteralStructure(source(text)).modes.some(g => g[2] === "choice")).toBe(false);
  });
  it("binds explicit bypass and valve controls to the named mode", () => {
    expect(compare(route, "基準側は分岐器から変換器を経て蓄積器へ流す第1・第2運転モードを切り換える。"))
      .toMatchObject([{ kind: "bypass", counterexample: ["第1運転モード", "from:分岐器", "bypass:変換器", "to:蓄積器"] }]);
    expect(compare(route, "変換器後に蓄積器へ流す第2運転モードを備える。")).toEqual([]);
    expect(compare(route, "変換器後に蓄積器へ流す第1・第2運転モードの一方を備える。")).toEqual([]);
    expect(compare(route.replace("経ること無く", "経て"), "変換器後に蓄積器へ流す第1・第2運転モードを備える。")).toEqual([]);
    expect(compare(route.replace("信号を前記蓄積器", "第３の開閉弁を開き、信号を前記蓄積器"), "変換器後に蓄積器へ流す第1・第2運転モードを備える。")).toEqual([]);
    expect(compare(route.replace("第２の開閉弁を開く", "第４の開閉弁を開く"), "変換器後に蓄積器へ流す第1・第2運転モードを備える。")).toEqual([]);
    expect(compare("停止要求があるときのみ、" + route, "変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
    expect(compare(route, "条件Bのとき、変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
    expect(compare(route, "変換器後に蓄積器へ流す第1運転モードを備えるとは断定できない。")).toEqual([]);
    expect(compare(route.replace("を切り換える。", "を切り換えるのは停止要求があるときだけである。"), "通常運転では変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
  });
  it("does not extend a bypass interval into exclusion from the entire mode", () => {
    const upstream = route.replace("信号を前記蓄積器に流す", "信号を変換器から分岐器を経て蓄積器へ流す");
    expect(compare(upstream, "変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
    expect(compare(route, "変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
    expect(compare(route, "分岐器から変換器を経て蓄積器へ流す第1運転モードの誤記を含む。")).toEqual([]);
    expect(compileLiteralStructure(source(route.replace("を切り換える。", "を切り換えるという構成を除く。"))).bypass).toEqual([]);
    expect(compare(route, "基準側について誤った説明は分岐器から変換器を経て蓄積器へ流す第1運転モードである。")).toEqual([]);
    const conditional = route.replace("を切り換える。", "を切り換えて実行する装置において、停止信号があるときだけ装置を動作させる。");
    const projected = compileLiteralStructure(source(conditional)).bypass;
    expect(projected).toHaveLength(1); expect(projected[0][1]).toBeNull();
    expect(conditional.slice(...projected[0][6])).toContain("停止信号があるときだけ");
    expect(compare(conditional, "分岐器から変換器を経て蓄積器へ流す第1運転モードを備える。")).toEqual([]);
  });
  it("keeps claim attribution local to each sentence of a source index", () => {
    const input = { claims: [...source(route, 1).claims, ...source("変換器後に蓄積器へ流す第1運転モードを備える。", 2).claims] };
    expect(compareLiteralStructure(input, "請求項1は変換器を迂回する。請求項2は変換器後に蓄積器へ流す第1運転モードを備える。")).toEqual([]);
  });
  it("does not apply the other side's identically named modes", () => {
    const input = source(modes()), target = "候補側は光・音・振動・表示のいずれかである。";
    expect(compareAttributedStructure(input, target, "base", true)).toEqual([]);
    expect(compareAttributedStructure(input, target.replace("候補側", "候補"), "base", true)).toEqual([]);
    expect(compareAttributedStructure(input, target, "candidate")).toHaveLength(1);
    expect(compareAttributedStructure(input, "光・音・振動・表示のいずれかである。", "base")).toEqual([]);
    expect(compareAttributedStructure(input, "誤った要約例は「確認する。基準側は光・音・振動・表示のいずれかである。ここまで」である。", "base", true)).toEqual([]);
  });
  it("bounds work for long unsupported labels and repeated topics", () => {
    const original = "甲".repeat(30_000) + "モードと、" + "前記第１の運転モードは不明。".repeat(1000);
    expect(compileLiteralStructure(source(original))).toEqual({ modes: [], bypass: [] });
  });
});
