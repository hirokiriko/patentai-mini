import { generateObject } from "ai";
import { z } from "zod";
import { getFastModel } from "./ai-model";
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
  keywordQueries: z.array(z.object({
    theme: z.string().describe("検索テーマ（例: 課題起点、手段起点、効果起点、構成要素起点）"),
    keywords: z.string().describe("J-PlatPat のキーワード検索にそのまま貼り付けできるキーワード列（スペース区切り）"),
  })).describe("J-PlatPat キーワード検索用のコピペ可能なキーワードセット（3〜5セット）"),
  searchExpansionHints: z.object({
    spellingVariants: z.array(z.object({
      baseTerm: z.string().describe("表記ゆれを検討すべき中心語"),
      variants: z.array(z.string()).max(6).describe("漢字/かな/カナ、長音、英語略語などの候補"),
      reason: z.string().describe("検索漏れにつながる理由"),
      suggestedUse: z.string().describe("追加検索での使い方。例: 広め検索に追加、別検索で確認"),
    })).max(5).describe("表記ゆれ・同義語・表記差の候補"),
    companyNameHints: z.array(z.object({
      observedName: z.string().describe("入力文面や技術分野から確認対象になりうる会社名・組織名"),
      relatedNames: z.array(z.string()).max(6).describe("旧社名、現社名、略称、英語名などの候補"),
      reason: z.string().describe("社名変遷や表記差として確認すべき理由"),
      confidence: z.enum(["high", "medium", "low"]).describe("候補の確からしさ。断定できない場合は low"),
    })).max(3).describe("社名変遷・出願人名ゆれの確認候補。根拠が薄い場合は空配列"),
    additionalKeywordQueries: z.array(z.object({
      theme: z.string().describe("追加検索の観点"),
      keywords: z.string().describe("J-PlatPat キーワード検索に貼り付ける追加候補"),
      note: z.string().describe("この追加検索で拾いたい漏れ筋"),
    })).max(3).describe("検索漏れ対策として別途試すキーワード検索候補（0〜3件）"),
    leakageRisks: z.array(z.string()).max(5).describe("表記ゆれ・社名変遷によって漏れやすい観点"),
  }).describe("検索漏れを減らすための表記ゆれ・社名変遷・追加検索ヒント"),
  excludedTerms: z.array(z.string()).describe("ノイズ除外語"),
  rationale: z.array(z.string()).describe("検索式設計の根拠（各判断の理由）"),
});

export type SearchQuerySet = z.infer<typeof searchQuerySetSchema>;

const SYSTEM_PROMPT = `あなたは特許調査の検索式設計エキスパートです。
与えられた特許案の構造化データから、J-PlatPat の「特許・実用新案テキスト検索」で実用になる論理式を生成してください。

## J-PlatPat 論理式の構文ルール（厳守）

### 演算子と優先順位（高い順）
1. \`[]\` 角括弧 — 最外殻ブロック（必ず 1 組だけ、論理式全体を包む）
2. \`*\` = AND
3. \`+\` = OR / \`-\` = NOT（同位）
- スペースを演算子の前後に入れない（例: ○ \`ベクトル/CL*キーワード/CL\`、× \`ベクトル/CL * キーワード/CL\`）

### 検索項目タグ
- \`/CL\` = 請求の範囲
- \`/AB\` = 要約
- \`/TI\` = 発明の名称
- \`/TX\` = 全文（明細書全体）

タグの付け方:
- 単語直後に付ける: \`ベクトル/CL\`
- カッコ式の直後に付ける: \`(ベクトル+埋め込)/CL\` ← カッコ全体に同じタグを後置できる

### ワイルドカード（前方一致）
- \`?\` をキーワード末尾に付ける
- 例: \`ベクトル?/TX\` → 「ベクトル」「ベクトル化」「ベクトル検索」等にマッチ
- ダブルクォートは使わない

### 文字数制限
- 1 つの論理式は **500 字以内**
- 各クエリ（broad/balanced/narrow）はそれぞれ独立に 500 字以内に収める

### 括弧のネストルール（最重要・違反すると構文エラーになる）

**最重要:** \`(語+語)/CL\` のように **タグ後置の式** は、その**式そのものをさらに丸カッコで括ってはいけません**。
J-PlatPat は「タグ付きカッコ式を更にカッコでグループ化する」ネストを認めません。
括弧の階層は浅く保ち、トップレベルで \`*\` (AND) と \`+\` (OR) を直接組み合わせるのが基本です。

### 正しい検索式の例

\`\`\`
# 広め（/TX で AND 結合、各 AND 項の中で同義語を OR 展開）
[(ベクトル?+embedding?+埋め込?)/TX*(キーワード検索+BM25+全文検索)/TX*(ハイブリッド+融合+RRF)/TX]

# 中庸（/CL の AND 検索を主軸に、同義語を OR 展開。/CL と /AB を混ぜたい場合は演算子優先順位を活用してフラットに並べる）
[(ベクトル?+埋め込?)/CL*(キーワード検索+BM25)/CL*(ハイブリッド+融合)/CL]
[(ベクトル?+埋め込?)/CL*(検索+サーチ)/CL+(ベクトル?+埋め込?)/AB*(検索+サーチ)/AB]

# 狭め（/CL の AND のみ、必須要素を絞る）
[ベクトル?/CL*キーワード検索/CL*ハイブリッド/CL]
\`\`\`

### 絶対にやってはいけない書き方（J-PlatPat が「論理式のカッコの使用方法が間違っています」エラーを返します）

\`\`\`
# NG-1: タグ後置のカッコ式を、さらに丸カッコで括っている
[((AI+人工知能)/CL+(AI+人工知能)/AB)*((機密+セキュリティ)/CL+(機密+セキュリティ)/AB)]

# NG-2: 同上（中庸で /CL+/AB の OR を AND する場合に陥りがち）
[((ベクトル?+埋め込?)/CL+(ベクトル?+埋め込?)/AB)*((キーワード+BM25)/CL+(キーワード+BM25)/AB)]

# NG-3: 最外殻 [] が複数あったり [] のネストが深い
[[ベクトル/CL]*[キーワード/CL]]

# 修正例（NG-1 を fix）— 演算子優先順位（* は + より強い）を使ってフラットに展開する
# 「(A_CL OR A_AB) AND (B_CL OR B_AB)」を 1 本の式で書きたい場合は、CL 群と AB 群をそれぞれ AND してから OR で結ぶ
[(AI+人工知能)/CL*(機密+セキュリティ)/CL+(AI+人工知能)/AB*(機密+セキュリティ)/AB]

# あるいは精度を一段上げるなら /CL のみに統一する（最も安全）
[(AI+人工知能)/CL*(機密+セキュリティ)/CL]
\`\`\`

### 絶対にやってはいけない書き方（その他）
- ダブルクォートでキーワードを囲む: × \`"ベクトル"\`
- タグなしのキーワード: × \`ベクトル*キーワード\`（必ず \`/CL\` 等を付ける）
- 演算子の前後にスペース: × \`ベクトル/CL + キーワード/CL\`
- カッコの中にカッコをネストして 3 階層を超える

## 検索式設計ルール
1. 独立請求項を主軸にする
2. 構成要素を分解し、必須要素 / 任意要素 / 効果語を区別する
3. 同義語・言い換えを展開する（過剰展開は禁止、各 OR グループは最大 5 語）
4. ノイズ語を除外リストに入れる
5. AND 項（\`*\` で繋ぐカッコ式）は **3〜5 個** に絞る（多すぎるとヒット 0 件になる）
6. 広め / 中庸 / 狭め の3段階を作る:
   - 広め: /TX（全文）で AND 結合、同義語・効果語も OR 展開
   - 中庸: /CL のみで AND 結合し主要同義語を OR 展開（**安全に通る形を最優先**）。CL+AB を混ぜたい時は「(A群)/CL\\*(B群)/CL+(A群)/AB\\*(B群)/AB」のフラット展開のみ許可
   - 狭め: /CL のみで AND 結合、必須要素のみ最小展開

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

## キーワード検索用セットの生成ルール
論理式とは別に、J-PlatPat の「キーワード検索」にそのまま貼り付けて使えるキーワードセットを生成する。
- 検索観点ごとにテーマを分けて 3〜5 セット生成する
- 各セットはスペース区切りのキーワード列（論理演算子・タグ不要）
- 日本語と英語を混在可（技術用語は両方あると有用）
- 同義語・言い換えも含めてよいが、1セット 10 語以内に収める
- テーマ例: 「課題起点」「手段起点」「効果起点」「構成要素起点」「応用分野起点」

## 表記ゆれ・社名変遷による検索漏れ対策
論理式とは別に、searchExpansionHints に検索漏れ対策を出す。
- spellingVariants には、漢字/ひらがな/カタカナ、長音記号「ー」の有無、半角/全角、英語略語、旧字体/新字体、一般語/専門語の候補を入れる
- companyNameHints には、入力文面や技術分野から確認対象になりうる会社名・組織名がある場合だけ、旧社名/現社名/略称/英語名の候補を入れる
- 社名変遷は断定せず、必ず「確認候補」として扱う。根拠が薄い場合は confidence を low にするか空配列にする
- main の broad/balanced/narrowQuery に候補を詰め込みすぎない。検索式本体は実行しやすさを優先し、追加確認は additionalKeywordQueries に分ける
- leakageRisks には「この表記だけで検索すると漏れそうな理由」を短く書く

## 注意
- 法的断定をしない
- 分類コード（IPC/FI/Fターム）は人手補完を前提とし、含めなくてよい`;

// 同期リクエスト内で安定して返すため、入力を検索式設計に必要な最小限へ圧縮する。
// 元の JSON.stringify(extracted) は elements の冗長表現で肥大化しがちで、fast モデルでも応答が遅くなる。
function compactExtractedForQueries(extracted: ExtractedClaims): string {
  const independentClaims = extracted.claims.filter((c) => c.isIndependent);
  const coreElements = independentClaims.flatMap((c) =>
    c.elements
      .filter((e) => e.importance === "core")
      .map((e) => `[${e.type}] ${e.text}`)
  );

  const sections: string[] = [];
  sections.push(`# 発明の名称\n${extracted.title}`);
  if (extracted.solvedProblems.length > 0) {
    sections.push(
      `# 解決課題\n${extracted.solvedProblems.map((p) => `- ${p}`).join("\n")}`
    );
  }
  if (extracted.effects.length > 0) {
    sections.push(
      `# 作用効果\n${extracted.effects.map((e) => `- ${e}`).join("\n")}`
    );
  }
  if (independentClaims.length > 0) {
    sections.push(
      `# 独立請求項\n${independentClaims
        .map((c) => `【請求項${c.claimNo}】\n${c.text}`)
        .join("\n\n")}`
    );
  }
  if (coreElements.length > 0) {
    sections.push(
      `# 独立請求項の必須構成要素（core）\n${coreElements
        .map((e) => `- ${e}`)
        .join("\n")}`
    );
  }
  return sections.join("\n\n");
}

export async function generateQueries(
  extracted: ExtractedClaims
): Promise<SearchQuerySet> {
  const prompt = compactExtractedForQueries(extracted);

  const { object } = await generateObject({
    model: getFastModel(),
    schema: searchQuerySetSchema,
    system: SYSTEM_PROMPT,
    prompt,
  });

  return object;
}
