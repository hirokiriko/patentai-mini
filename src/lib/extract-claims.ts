import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

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

export async function extractClaims(
  parsedText: string
): Promise<ExtractedClaims> {
  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: extractedClaimsSchema,
    system: SYSTEM_PROMPT,
    prompt: parsedText,
  });

  return object;
}
