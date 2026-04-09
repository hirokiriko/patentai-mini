import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { ExtractedClaims } from "./extract-claims";

// --- Step 1: スクリーニング ---

const screeningResultSchema = z.object({
  relevantDocIds: z
    .array(z.number())
    .describe("詳細分析すべき先行技術文献の docId（関連度上位、最大20件）"),
  reasoning: z.string().describe("絞り込みの根拠"),
});

interface PriorArtSummary {
  docId: number;
  publicationNo: string | null;
  title: string | null;
  abstract: string | null;
}

export async function screenPriorArt(
  extracted: ExtractedClaims,
  priorArts: PriorArtSummary[]
): Promise<{ relevantDocIds: number[]; reasoning: string }> {
  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: screeningResultSchema,
    system: `あなたは特許調査の専門家です。
特許案の請求項・構成要素と、先行技術文献のリストを比較し、
詳細な重なり分析を行うべき関連度の高い文献を最大20件選んでください。

選定基準:
- 独立請求項の構成要素と技術的に関連があるもの
- 課題・手段・効果のいずれかが類似するもの
- タイトルや要約の表層的な単語一致だけでなく、技術的な関連性を判断する`,
    prompt: JSON.stringify({
      draftClaims: extracted,
      priorArts: priorArts.map((pa) => ({
        docId: pa.docId,
        publicationNo: pa.publicationNo,
        title: pa.title,
        abstract: pa.abstract?.substring(0, 500),
      })),
    }),
  });

  return object;
}

// --- Step 2: 詳細分析 ---

const comparisonSchema = z.object({
  results: z.array(
    z.object({
      draftClaimNo: z.number().describe("対象の請求項番号"),
      priorDocId: z.number().describe("対象の先行技術文献 docId"),
      lexicalScore: z
        .number()
        .min(0)
        .max(1)
        .describe("L1 文字列一致スコア (0-1)"),
      elementScore: z
        .number()
        .min(0)
        .max(1)
        .describe("L2 要素一致スコア (0-1)"),
      semanticScore: z
        .number()
        .min(0)
        .max(1)
        .describe("L3 意味類似スコア (0-1)"),
      structuralScore: z
        .number()
        .min(0)
        .max(1)
        .describe("L4 構造比較スコア (0-1)"),
      matchedElements: z
        .array(z.string())
        .describe("一致した構成要素"),
      unmatchedElements: z
        .array(z.string())
        .describe("一致しなかった制約・構成要素"),
      riskLabel: z
        .enum(["High", "Medium", "Low", "Unknown"])
        .describe("リスクラベル"),
      explanation: z
        .string()
        .describe("比較結果の説明（どこが一致し、どこが異なるか）"),
    })
  ),
});

export type ComparisonResult = z.infer<
  typeof comparisonSchema
>["results"][number];

interface PriorArtDetail {
  docId: number;
  publicationNo: string | null;
  title: string | null;
  abstract: string | null;
  claimsText: string | null;
}

export async function analyzeOverlap(
  extracted: ExtractedClaims,
  priorArts: PriorArtDetail[]
): Promise<ComparisonResult[]> {
  // 独立請求項のみを分析対象にする
  const independentClaims = extracted.claims.filter((c) => c.isIndependent);

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: comparisonSchema,
    system: `あなたは特許調査の専門家です。特許案の請求項と先行技術文献の重なりを分析してください。

## 分析の4層モデル
- L1 文字列一致: 完全一致、重要語一致、n-gram 類似
- L2 要素一致: 構成要素（名詞句、動作、制約、入出力）の対応
- L3 意味類似: 同義表現・言い換えを含む意味的な近さ
- L4 構造比較: 「AがBを制御する」等の要素間関係の一致

## スコアリング
各レイヤ 0〜1 のスコア。
overall = 0.30 * lexical + 0.35 * element + 0.20 * semantic + 0.15 * structural

## リスクラベル
- High: 独立請求項の必須要素が多数一致
- Medium: 一部一致だが重要制約に差分あり
- Low: 語彙類似はあるが構造差が大きい
- Unknown: 解析不能、または原文不足

## 必須の説明内容
- どの構成要素が一致したか
- どの制約が一致しなかったか
- 作用効果レベルの近似に過ぎない箇所
- 人手確認が必要な箇所

## 注意
- 類似度が高い = 新規性なし ではない
- 「拒絶される」「登録できない」等の断定は絶対にしない
- 「重複候補」「一致候補」「確認が必要」等の表現を使う
- 各独立請求項×各先行技術文献の組み合わせで分析する`,
    prompt: JSON.stringify({
      draftClaims: independentClaims,
      priorArts: priorArts.map((pa) => ({
        docId: pa.docId,
        publicationNo: pa.publicationNo,
        title: pa.title,
        abstract: pa.abstract,
        claimsText: pa.claimsText?.substring(0, 2000),
      })),
    }),
  });

  return object.results;
}
