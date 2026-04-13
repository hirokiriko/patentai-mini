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
      return google(model ?? "gemini-2.5-flash-preview-05-20");
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
      return google("gemini-2.0-flash");
    case "openai":
      return openai("gpt-4o-mini");
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}
