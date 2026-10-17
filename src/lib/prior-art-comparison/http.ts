import { ComparisonError } from "./source";
export const COMPARISON_ERRORS = {
  source_review_required: "保存原文の請求項番号・全文・参照・画像や数式を確認してください。対応する日本語テキストを取り込み直す必要があります。",
  selection_invalid: "同じ案件の文献2〜3件と、存在する請求項番号・文献名・版を指定してください。",
  plan_limit: "指定範囲が同期比較の上限を超えます。AIは実行していません。指定請求項を絞ってください。",
  ai_incomplete: "比較が完了しませんでした。以前の保存結果は変更していません。AI設定・利用状況と原文を確認してください。",
  stale_input: "入力が変更されています。再読込して比較範囲と原文を確認してください。",
  save_unconfirmed: "保存または実行中の状態を確定できません。再実行せず、保存結果を再読込して照合してください。",
  result_invalid: "保存結果の整合を確認できません。この結果の出力は停止しています。",
  not_found: "対象の案件または保存結果が見つかりません。",
} as const;
export function caseNumber(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2147483647) throw new ComparisonError("not_found");
  return Number(value);
}
export function comparisonFailure(error: unknown): Response {
  const code = error instanceof ComparisonError ? error.code : "ai_incomplete";
  return Response.json({ error: COMPARISON_ERRORS[code], code }, { status: code === "not_found" ? 404 : code === "stale_input" || code === "save_unconfirmed" ? 409 : 422 });
}
