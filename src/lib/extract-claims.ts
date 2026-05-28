import { generateObject } from "ai";
import { z } from "zod";
import { getErrorMessage, runWithAiRetries } from "./ai-resilience";
import { getFastModel } from "./ai-model";

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

// 特許明細書の主要セクションを抽出し、図面説明等の冗長部分を除く。
// 同期リクエスト内で安定して応答できるよう 15,000 文字に制限。
function trimPatentText(text: string, maxChars: number = 15000): string {
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

  // セクション抽出で内容が少なすぎる場合はテキスト先頭から切り出す
  if (combined.trim().length < 500) {
    return text.substring(0, maxChars);
  }

  return combined.substring(0, maxChars);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}...`
    : normalized;
}

function toHalfWidthNumber(value: string): number | null {
  const normalized = value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  );
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickLine(text: string, patterns: RegExp[]): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const pattern of patterns) {
    const match = lines.find((line) => pattern.test(line));
    if (match) {
      return match.replace(pattern, "").replace(/^[:：\s]+/, "").trim();
    }
  }

  return null;
}

function inferElementType(
  text: string
): z.infer<typeof claimElementSchema>["type"] {
  const lower = text.toLowerCase();
  if (/(data|input|output|signal|voltage|current|temperature|通信|入力|出力|データ)/i.test(text)) {
    return "io";
  }
  if (/(wherein|when|based on|threshold|condition|limit|条件|制御|制限)/i.test(text)) {
    return "constraint";
  }
  if (/(reduce|improve|effect|advantage|抑制|改善|効果)/i.test(text)) {
    return "effect";
  }
  if (/(receive|estimate|control|adjust|transmit|display|取得|推定|調整|送信|表示)/i.test(text)) {
    return "action";
  }
  return lower.includes("method") ? "action" : "component";
}

function splitClaimElements(
  text: string
): z.infer<typeof claimElementSchema>[] {
  const phrases = text
    .split(/[.;；。]|,\s+(?=(?:and|wherein|comprising|a|an|the)\b)/i)
    .map((phrase) => truncate(phrase, 180))
    .filter((phrase) => phrase.length >= 8)
    .slice(0, 6);

  const source = phrases.length > 0 ? phrases : [truncate(text, 180)];

  return source.map((phrase, index) => ({
    type: inferElementType(phrase),
    text: phrase,
    importance: index < 3 ? "core" : "optional",
  }));
}

function extractClaimCandidates(text: string): z.infer<typeof claimSchema>[] {
  const claims: z.infer<typeof claimSchema>[] = [];
  const pattern =
    /(?:^|\n)\s*(?:Claim|claim|請求項|【請求項)\s*([0-9０-９]+)\s*(?:】|\.|:|：)?\s*([\s\S]*?)(?=(?:\n\s*(?:Claim|claim|請求項|【請求項)\s*[0-9０-９]+)|$)/g;

  for (const match of text.matchAll(pattern)) {
    const claimNo = toHalfWidthNumber(match[1]) ?? claims.length + 1;
    const claimText = truncate(match[2] ?? "", 1200);
    if (!claimText) continue;
    const dependencyMatch = claimText.match(
      /(?:according to|of)\s+claim\s+([0-9０-９]+)|請求項\s*([0-9０-９]+)/i
    );
    const dependsOn = toHalfWidthNumber(
      dependencyMatch?.[1] ?? dependencyMatch?.[2] ?? ""
    );

    claims.push({
      claimNo,
      text: claimText,
      isIndependent: !dependsOn || dependsOn === claimNo,
      dependsOn: dependsOn && dependsOn !== claimNo ? dependsOn : null,
      elements: splitClaimElements(claimText),
    });
  }

  if (claims.length > 0) return claims;

  const fallbackText = truncate(text, 1200);
  return [
    {
      claimNo: 1,
      text: fallbackText,
      isIndependent: true,
      dependsOn: null,
      elements: splitClaimElements(fallbackText),
    },
  ];
}

function buildFallbackExtractedClaims(parsedText: string): ExtractedClaims {
  const trimmed = parsedText.trim();
  const title =
    pickLine(trimmed, [
      /^(?:Title|title|発明の名称|【発明の名称】)\s*[:：]?/i,
    ]) ?? "Draft patent";
  const abstract =
    pickLine(trimmed, [/^(?:Abstract|Summary|要約)\s*[:：]?/i]) ??
    truncate(trimmed, 500);
  const problem = pickLine(trimmed, [/^(?:Problem|課題)\s*[:：]?/i]);
  const effect = pickLine(trimmed, [/^(?:Effect|効果)\s*[:：]?/i]);
  const claims = extractClaimCandidates(trimmed);

  return {
    title: truncate(title, 120),
    abstract,
    solvedProblems: problem ? [problem] : [],
    effects: effect ? [effect] : [],
    claims,
  };
}

export async function extractClaims(
  parsedText: string
): Promise<ExtractedClaims> {
  const trimmed = trimPatentText(parsedText);

  // 抽出は高速モデルを使用（重い推論モデルは同期リクエストで遅くなりやすいため）
  try {
    return await runWithAiRetries(
      "extract-claims",
      async () => {
        const { object } = await generateObject({
          model: getFastModel(),
          schema: extractedClaimsSchema,
          system: SYSTEM_PROMPT,
          prompt: trimmed,
          maxRetries: 1,
          timeout: 35000,
        });

        return object;
      },
      { attempts: 2 }
    );
  } catch (error) {
    console.warn(
      `[extract-claims] using fallback parser after AI failure: ${getErrorMessage(error)}`
    );
    return buildFallbackExtractedClaims(trimmed);
  }
}
