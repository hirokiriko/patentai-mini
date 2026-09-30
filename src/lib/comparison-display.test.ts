import { describe, expect, it } from "vitest";
import { comparisonExplanation, comparisonAnalysisDisplay } from "./comparison-display";

describe("neutral comparison display", () => {
  it.each(["High", "Medium", "Low", "Unknown"])("removes only an assessment for %s", label => {
    const text = `リスク: ${label}。光学部は一致。温度制約は未確認。`;
    expect(comparisonExplanation(text)).toBe("原文確認が必要。光学部は一致。温度制約は未確認。");
    expect(comparisonExplanation(`${label}: 光学部は一致。`)).toBe("光学部は一致。");
  });
  it("keeps evidence, technical words and unknown execution states", () => {
    const text = '「High voltage」及びlow latency。高感度・低電力。実行結果不明、未実行、原文不足。';
    expect(comparisonExplanation(text)).toBe(text);
    expect(comparisonExplanation('引用「高リスク」は原文の記載。')).toBe('引用「高リスク」は原文の記載。');
    expect(comparisonExplanation('リスク低減機構と温度制御部は一致する。')).toBe('リスク低減機構と温度制御部は一致する。');
    expect(comparisonExplanation('処理結果Unknown（応答なし）。')).toBe('処理結果Unknown（応答なし）。');
    expect(comparisonExplanation('原文「リスクは『高』と記載」と一致。')).toBe('原文「リスクは『高』と記載」と一致。');
    expect(comparisonExplanation('候補請求項は低リスク手術のための器具を記載する。')).toBe('候補請求項は低リスク手術のための器具を記載する。');
  });
  it("distinguishes assessment results from unknown processing states", () => {
    expect(comparisonExplanation('請求項1のリスクは「高」。請求項2のリスクは「低」。温度条件は未確認。')).toBe('請求項1の原文確認が必要。請求項2の原文確認が必要。温度条件は未確認。');
    expect(comparisonExplanation('評価結果: High。温度制約は未確認。')).toBe('評価結果: 原文確認が必要。温度制約は未確認。');
    expect(comparisonExplanation('判定結果: Medium。光学部は一致。')).toBe('判定結果: 原文確認が必要。光学部は一致。');
    expect(comparisonExplanation('本件のリスクは高いと考えられる。温度制約は未確認。')).toBe('本件の原文確認が必要と考えられる。温度制約は未確認。');
  });
  it.each(['本件はHighです。温度条件は未確認。', 'リスクレベル: Medium。光学部は一致。', 'Unknown（原文不足のため構造未確認）', 'リスクは「高」と評価。光学部は一致。'])("removes contextual legacy tiers but keeps the explanation: %s", text => {
    expect(comparisonExplanation(text)).not.toMatch(/High|Medium|Unknown|「高」/);
    expect(comparisonExplanation(text)).toContain(text.includes('光学部') ? '光学部は一致' : text.includes('温度') ? '温度条件は未確認' : '原文不足のため構造未確認');
  });
  it("projects generated explanations without changing the stored object", () => {
    const value = { matchedElements: ["高リスク、光学部は一致"], unmatchedElements: ["低電力制御は未確認"], explanation: "Mediumと判断。一部は要確認。" };
    const before = structuredClone(value), display = comparisonAnalysisDisplay(value);
    expect(display.explanation).toBe("原文確認が必要。一部は要確認。");
    expect(display.matchedElements[0]).toBe("原文確認が必要、光学部は一致");
    expect(display.unmatchedElements).toEqual(value.unmatchedElements);
    expect(value).toEqual(before);
  });
});
