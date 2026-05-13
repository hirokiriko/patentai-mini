import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

/**
 * 環境変数で LLM プロバイダー/モデルを切り替える。
 *
 * AI_PROVIDER: "google" | "openai"（デフォルト: "google"）
 * AI_MODEL: プロバイダーごとのモデル名（デフォルト: プロバイダー依存）
 */
export function getModel() {
  const provider = process.env.AI_PROVIDER ?? "google";
  const model = process.env.AI_MODEL;

  switch (provider) {
    case "google":
      // analyze-overlap などの重い分析用。flash-lite (stable) を採用。
      // flash-preview は thinkingLevel='minimal' を受け付けない（実機エラー
      // "Thinking level MINIMAL is not supported for this model"）ため、
      // minimal を明示的に使いたい本プロジェクトでは flash-lite を選ぶ。
      // 呼び出し側で providerOptions.google.thinkingConfig.thinkingLevel='minimal' を明示する。
      return google(model ?? "gemini-3.1-flash-lite");
    case "openai":
      return openai(model ?? "gpt-4o");
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}

/**
 * 抽出・パース等の高速処理向けモデル。
 * 思考（thinking）を持たない非推論モデルを返す。
 * Vercel Hobby の 60 秒制限内で確実に完了させるため使用する。
 */
export function getFastModel() {
  const provider = process.env.AI_PROVIDER ?? "google";

  switch (provider) {
    case "google":
      return google("gemini-3.1-flash-lite");
    case "openai":
      return openai("gpt-4o-mini");
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}
