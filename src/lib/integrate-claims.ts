import { generateText } from "ai";
import { getFastModel } from "./ai-model";

const SYSTEM_PROMPT = `あなたは特許明細書の統合エキスパートです。
ユーザーは「公開前のベース出願（自身の出願済み特許）」に「新規事項」を追加して、
新しい別の特許として出願（特許法 41 条 国内優先権主張出願）したいと考えています。

入力として下記が与えられます。
- ベース出願テキスト
- 新規事項テキスト

両者を統合した「新しい発明全体の明細書テキスト」を生成してください。
後段の請求項抽出 AI が請求項・課題・効果を抽出するための入力になります。

## 統合ルール
- ベース出願の発明の趣旨を維持しつつ、新規事項を自然に組み込む
- 元のベース出願の独立請求項に新規事項の限定を加えた形で、統合後の独立請求項を再構成する
- 推測で追加情報を補わない
- 「登録可能」「拒絶されない」等の法的判断は含めない

## 出力ルール
- 必ず日本語で出力する
- Markdown は使わず、下記の特許明細書フォーマットに従う
- 各セクションは簡潔にまとめ、**全体で 3500 字以内**を目安にする
- 背景技術・実施例の詳細は短く要約してよい（請求項は省略しない）

## 出力フォーマット
【発明の名称】
（統合後の名称）

【発明が解決しようとする課題】
（ベース + 新規事項で追加される課題）

【課題を解決するための手段】
（統合した手段の概要）

【発明の効果】
（統合した効果）

【特許請求の範囲】
【請求項1】
（統合後の独立請求項。ベースの独立請求項に新規事項の限定を加えた形）

【請求項2】（必要なら 1〜3 個程度）

【発明を実施するための形態】
（短い実施例）`;

export interface IntegrateClaimsInput {
  baseText: string;
  additionText: string;
  baseApplicationNumber?: string | null;
}

export interface IntegrateClaimsOutput {
  integratedText: string;
}

function trim(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.substring(0, maxChars);
}

export async function integrateClaims(
  input: IntegrateClaimsInput
): Promise<IntegrateClaimsOutput> {
  // 同期リクエスト内で安定して返すため、入力を圧縮し fast モデルを使う。
  const baseTrimmed = trim(input.baseText, 8000);
  const additionTrimmed = trim(input.additionText, 3000);

  const userPrompt = [
    input.baseApplicationNumber
      ? `# ベース出願番号\n${input.baseApplicationNumber}\n`
      : "",
    `# ベース出願テキスト\n${baseTrimmed}\n`,
    `# 新規事項テキスト\n${additionTrimmed}\n`,
    "上記を統合した「新しい発明全体の明細書テキスト」を 3500 字以内で出力してください。",
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await generateText({
    model: getFastModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  return { integratedText: text };
}
