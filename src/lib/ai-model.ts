import { createAzure } from "@ai-sdk/azure";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";

/**
 * 環境変数で LLM プロバイダー/モデルを切り替える。
 *
 * AI_PROVIDER: "google" | "openai" | "azure"（デフォルト: "google"）
 * AI_MODEL: プロバイダーごとのモデル名（デフォルト: プロバイダー依存）
 * Azure OpenAI はモデル名ではなく deployment name を指定する。
 */
function getProvider() {
  return process.env.AI_PROVIDER ?? "google";
}

function readRequiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable for AI_PROVIDER=azure: ${name}`
    );
  }
  return value;
}

function readAzureEndpoint() {
  const baseURL = process.env.AZURE_OPENAI_BASE_URL?.trim().replace(/\/+$/, "");
  const resourceName = process.env.AZURE_RESOURCE_NAME?.trim();

  if (baseURL) return { baseURL };
  if (resourceName) return { resourceName };

  throw new Error(
    "Missing required environment variable for AI_PROVIDER=azure: AZURE_RESOURCE_NAME or AZURE_OPENAI_BASE_URL"
  );
}

function getAzureProvider() {
  return createAzure({
    ...readAzureEndpoint(),
    apiKey: readRequiredEnv("AZURE_API_KEY"),
    apiVersion: readRequiredEnv("AZURE_OPENAI_API_VERSION"),
  });
}

function getAzureDeploymentName(): string {
  return readRequiredEnv("AZURE_OPENAI_DEPLOYMENT_NAME");
}

function getAzureFastDeploymentName(): string {
  return (
    process.env.AZURE_OPENAI_FAST_DEPLOYMENT_NAME?.trim() ||
    getAzureDeploymentName()
  );
}

export function isGoogleProvider(): boolean {
  return getProvider() === "google";
}

export function getGoogleThinkingProviderOptions() {
  if (!isGoogleProvider()) return undefined;
  return {
    google: {
      thinkingConfig: {
        thinkingLevel: "minimal" as const,
      },
    },
  };
}

export function getModel() {
  const provider = getProvider();
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
    case "azure":
      return getAzureProvider()(getAzureDeploymentName());
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
  const provider = getProvider();

  switch (provider) {
    case "google":
      return google("gemini-3.1-flash-lite");
    case "openai":
      return openai("gpt-4o-mini");
    case "azure":
      return getAzureProvider()(getAzureFastDeploymentName());
    default:
      throw new Error(`Unknown AI_PROVIDER: ${provider}`);
  }
}
