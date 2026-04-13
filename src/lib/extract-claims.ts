import { generateObject, streamObject } from "ai";
import { z } from "zod";
import { getModel } from "./ai-model";

const claimElementSchema = z.object({
  type: z.enum(["component", "action", "constraint", "io", "effect"]),
  text: z.string(),
  importance: z.enum(["core", "optional"]),
});

const claimSchema = z.object({
  claimNo: z.number(),
  text: z.string(),
  isIndependent: z.boolean(),
  dependsOn: z.number().nullable(),
  elements: z.array(claimElementSchema),
});

export const extractedClaimsSchema = z.object({
  title: z.string().describe("発明の名称"),
  abstract: z.string().describe("要約"),
  solvedProblems: z.array(z.string()).describe("解決課題"),
  effects: z.array(z.string()).describe("作用効果"),
  claims: z.array(claimSchema).describe("請求項一覧"),
});

export type ExtractedClaims = z.infer<typeof extractedClaimsSchema>;

const SYSTEM_PROMPT = `あなたは特許文書の構造解析エキスパートです。
与えられた特許案のテキストから、以下を正確に抽出してください。

## 抽出ルール
- 請求項は原文に忠実に抽出する
- 独立請求項（他の請求項を引用しないもの）と従属請求項を区別する
- 各請求項を構成要素に分解する:
  - component: 物理的/論理的な構成部品
  - action: 動作・処理・工程
  - constraint: 条件・制約・限定
  - io: 入出力・データの流れ
  - effect: 作用効果・結果
- importance は、独立請求項の成立に不可欠なものを "core"、従属や効果的なものを "optional" とする
- 発明の名称、要約、解決課題、作用効果も抽出する
- テキストに明示されていない情報は推測しない

## 注意
- 「登録可能」「拒絶されない」等の法的判断は含めない
- 名詞句の列挙で終わらず、要素・関係・制約・作用効果に分解する`;

// 特許明細書の主要セクションを抽出し、図面説明等の冗長部分を除く
function trimPatentText(text: string, maxChars: number = 30000): string {
  if (text.length <= maxChars) return text;

  // 請求項セクションを優先保持（【特許請求の範囲】〜次の【】まで）
  const claimsMatch = text.match(
    /【(?:書類名】特許請求の範囲|特許請求の範囲)】[\s\S]*?(?=【書類名】|$)/
  );
  const claims = claimsMatch?.[0] ?? "";

  // 要約・課題・効果セクションを探す
  const summaryMatch = text.match(
    /【(?:要約|課題|発明の効果|技術分野|背景技術)】[\s\S]*?(?=【図面の簡単な説明】|【符号の説明】|$)/
  );
  const summary = summaryMatch?.[0] ?? "";

  const combined = claims + "\n\n" + summary;
  return combined.substring(0, maxChars);
}

export async function extractClaims(
  parsedText: string
): Promise<ExtractedClaims> {
  const trimmed = trimPatentText(parsedText);

  const { object } = await generateObject({
    model: getModel(),
    schema: extractedClaimsSchema,
    system: SYSTEM_PROMPT,
    prompt: trimmed,
  });

  return object;
}

/**
 * ストリーミング版の請求項抽出。
 * 思考モデル（gemini-2.5-flash 等）で長時間かかる場合に
 * HTTP 接続を維持してタイムアウトを回避する。
 */
export function extractClaimsStream(parsedText: string) {
  const trimmed = trimPatentText(parsedText);

  return streamObject({
    model: getModel(),
    schema: extractedClaimsSchema,
    system: SYSTEM_PROMPT,
    prompt: trimmed,
  });
}
