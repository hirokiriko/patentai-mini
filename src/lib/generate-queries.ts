import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { ExtractedClaims } from "./extract-claims";

export const searchQuerySetSchema = z.object({
  keywordGroups: z.object({
    core: z.array(z.string()).describe("独立請求項の必須構成要素に由来するキーワード"),
    synonyms: z.array(z.string()).describe("core の同義語・言い換え"),
    effects: z.array(z.string()).describe("作用効果に由来するキーワード"),
  }),
  broadQuery: z.string().describe("広め検索式 — 再現率重視"),
  balancedQuery: z.string().describe("中庸検索式 — 再現率と適合率のバランス"),
  narrowQuery: z.string().describe("狭め検索式 — 適合率重視"),
  excludedTerms: z.array(z.string()).describe("ノイズ除外語"),
  rationale: z.array(z.string()).describe("検索式設計の根拠（各判断の理由）"),
});

export type SearchQuerySet = z.infer<typeof searchQuerySetSchema>;

const SYSTEM_PROMPT = `あなたは特許調査の検索式設計エキスパートです。
与えられた特許案の構造化データから、J-PlatPat で実用になる検索式を生成してください。

## 検索式設計ルール
1. 独立請求項を主軸にする
2. 構成要素を分解し、必須要素 / 任意要素 / 効果語を区別する
3. 同義語・言い換えを展開する（過剰展開は禁止）
4. ノイズ語を除外リストに入れる
5. 広め / 中庸 / 狭め の3段階を作る:
   - 広め: core キーワードの OR 展開 + 同義語、効果語も含む
   - 中庸: core の AND + 主要同義語の OR
   - 狭め: core の AND のみ、限定的な同義語
6. J-PlatPat の検索式記法を意識する:
   - キーワード AND/OR 演算子
   - 検索項目タグ（例: /CL で請求の範囲、/AB で要約）
   - ワイルドカード ? が使える

## 検索観点
- 課題起点: どんな問題を解決するか
- 手段起点: どんな技術手段を使うか
- 効果起点: どんな効果が得られるか
- 構成要素起点: どんな部品・モジュールがあるか

## 失敗パターン（避けること）
- 発明の説明をそのまま長文で検索式化する
- 効果語だけで検索してしまう
- 独立請求項の必須制約を落とす
- 同義語展開が過剰でノイズ化する

## 注意
- 法的断定をしない
- 分類コード（IPC/FI/Fターム）は人手補完を前提とし、含めなくてよい`;

export async function generateQueries(
  extracted: ExtractedClaims
): Promise<SearchQuerySet> {
  const prompt = JSON.stringify(extracted, null, 2);

  const { object } = await generateObject({
    model: openai("gpt-4o"),
    schema: searchQuerySetSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object;
}
