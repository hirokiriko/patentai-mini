import { generateText } from "ai";
import { getModel } from "./ai-model";

const SYSTEM_PROMPT = `あなたは特許明細書の統合エキスパートです。
ユーザーは「公開前のベース出願（自身の出願済み特許）」に「新規事項」を追加して、
新しい別の特許として出願（特許法 41 条 国内優先権主張出願）したいと考えています。

入力として下記が与えられます。
- ベース出願テキスト: 既に出願済みの公開前特許の本文
- 新規事項テキスト: ベース出願に追加したい技術的事項（例: UI、新しい機能、追加の構成要素など）

あなたのタスクは、両者を統合した「新しい発明全体の明細書テキスト」を生成することです。
このテキストは、後段の請求項抽出 AI が請求項・課題・効果を抽出するための入力になります。

## 統合ルール
- ベース出願の発明の名称・解決課題・作用効果・請求項の趣旨を維持しつつ、新規事項を自然に組み込む
- 新規事項を新しい構成要素として明細書に統合し、独立請求項にも反映させる
- 元のベース出願の請求項に新規事項の限定を追加した形で、統合後の独立請求項を再構成する
- 推測で追加情報を補わない。両入力に書かれていない技術的詳細は書かない
- 請求項の番号は新しく振り直す（独立請求項を 1 番に）
- 「登録可能」「拒絶されない」等の法的判断は含めない

## 出力フォーマット
以下の構造で 1 つのテキストとして出力してください。Markdown は使わず、特許明細書の慣用書式に従う。

【発明の名称】
（統合後の名称）

【技術分野】
（ベース出願の技術分野を簡潔に。新規事項で範囲が広がる場合は反映）

【背景技術】
（ベース出願の背景技術を要約）

【発明が解決しようとする課題】
（ベース出願の課題 + 新規事項によって追加される課題があれば併記）

【課題を解決するための手段】
（ベース出願の手段 + 新規事項を統合した手段の説明）

【発明の効果】
（ベース出願の効果 + 新規事項によって生じる追加の効果）

【特許請求の範囲】
【請求項1】
（統合後の独立請求項。ベース出願の独立請求項に新規事項の限定を加えた形）

【請求項2】（必要なら）
（統合後の従属請求項）

...

【発明を実施するための形態】
（ベース出願の実施例 + 新規事項の説明）`;

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
  const baseTrimmed = trim(input.baseText, 12000);
  const additionTrimmed = trim(input.additionText, 6000);

  const userPrompt = [
    input.baseApplicationNumber
      ? `# ベース出願番号\n${input.baseApplicationNumber}\n`
      : "",
    `# ベース出願テキスト\n${baseTrimmed}\n`,
    `# 新規事項テキスト\n${additionTrimmed}\n`,
    "上記を統合した「新しい発明全体の明細書テキスト」を出力してください。",
  ]
    .filter(Boolean)
    .join("\n");

  const { text } = await generateText({
    model: getModel(),
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });

  return { integratedText: text };
}
