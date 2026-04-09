import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "./ai-model";
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
与えられた特許案の構造化データから、J-PlatPat の「特許・実用新案テキスト検索」で実用になる論理式を生成してください。

## J-PlatPat 論理式の構文ルール（厳守）

### 演算子
- \`*\` = AND
- \`+\` = OR
- スペースを演算子の前後に入れない（例: ○ \`ベクトル/CL*キーワード/CL\`、× \`ベクトル/CL * キーワード/CL\`）

### 検索項目タグ（各キーワードの末尾に必ず付ける）
- \`/CL\` = 請求の範囲
- \`/AB\` = 要約
- \`/TI\` = 発明の名称
- \`/TX\` = 全文（明細書全体）

### ワイルドカード（前方一致）
- \`?\` をキーワード末尾に付けて前方一致検索する
- 例: \`ベクトル?/TX\` → 「ベクトル」「ベクトル化」「ベクトル検索」等にマッチ
- ダブルクォートは使わない

### 括弧
- \`[]\`（角括弧）: 最外殻のブロック
- \`()\`: ブロック内のグルーピング

### 英語フレーズ
- 複数単語の英語フレーズはシングルクォートで囲む: \`'natural language processing'/TX\`

### 正しい検索式の例
\`\`\`
[(ベクトル?+embedding?)/TX*(キーワード検索+BM25)/TX*(ハイブリッド+融合)/TX]
[(ベクトル?+埋め込?)/CL*(検索+サーチ)/CL*(言語モデル+LLM)/CL]
\`\`\`

### 絶対にやってはいけない書き方
- ダブルクォートでキーワードを囲む: × \`"ベクトル"\`
- タグなしのキーワード: × \`ベクトル*キーワード\`（必ず \`/CL\` 等を付ける）
- 演算子の前後にスペース: × \`ベクトル/CL + キーワード/CL\`

## 検索式設計ルール
1. 独立請求項を主軸にする
2. 構成要素を分解し、必須要素 / 任意要素 / 効果語を区別する
3. 同義語・言い換えを展開する（過剰展開は禁止）
4. ノイズ語を除外リストに入れる
5. 広め / 中庸 / 狭め の3段階を作る:
   - 広め: /TX（全文）で検索、同義語・効果語も OR 展開
   - 中庸: /CL（請求の範囲）+ /AB（要約）で検索、主要同義語の OR
   - 狭め: /CL のみで検索、core キーワードの AND

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
- ダブルクォートを使う
- タグを付け忘れる

## 注意
- 法的断定をしない
- 分類コード（IPC/FI/Fターム）は人手補完を前提とし、含めなくてよい`;

export async function generateQueries(
  extracted: ExtractedClaims
): Promise<SearchQuerySet> {
  const prompt = JSON.stringify(extracted, null, 2);

  const { object } = await generateObject({
    model: getModel(),
    schema: searchQuerySetSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object;
}
