import mammoth from "mammoth";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  extractTextWithDocumentIntelligence,
  getDocumentIntelligenceMissingEnv,
  isDocumentIntelligenceConfigured,
} from "@/lib/document-intelligence";

// pdfjs-dist は Node 実行時に require("@napi-rs/canvas") で DOMMatrix 等を
// polyfill する。Vercel Lambda に自動追跡させるため、side-effect import で
// 明示的に参照しておく。
import "@napi-rs/canvas";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// pnpm の node_modules は symlink で、かつ pdf.worker.mjs のような動的
// import 対象は Next.js の output tracing で拾われない。postinstall で
// vendor/ に全部コピーし、そこから動的 import する。
const PDFJS_ASSETS_ROOT = path.join(process.cwd(), "vendor", "pdfjs-dist");
const PDFJS_MODULE_PATH = path.join(PDFJS_ASSETS_ROOT, "legacy", "build", "pdf.mjs");
const CMAP_URL = pathToFileURL(path.join(PDFJS_ASSETS_ROOT, "cmaps") + path.sep).href;
const STANDARD_FONT_DATA_URL = pathToFileURL(
  path.join(PDFJS_ASSETS_ROOT, "standard_fonts") + path.sep
).href;
const MIN_USABLE_TEXT_LENGTH = 40;
const MOJIBAKE_HINT_CHARS = new Set(
  "縺繧譁謚蜊逕蟆髱螟荳蛟蠑邱隕雎霎驥驕荳蜃谿鬘荳"
);

type TextQuality = "usable" | "empty" | "garbled";

export class FileParseError extends Error {
  constructor(
    message: string,
    readonly code: string
  ) {
    super(message);
    this.name = "FileParseError";
  }
}

export function isFileParseError(error: unknown): error is FileParseError {
  return error instanceof FileParseError;
}

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;
function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import(
      /* webpackIgnore: true */
      /* @vite-ignore */
      pathToFileURL(PDFJS_MODULE_PATH).href
    ) as Promise<PdfJsModule>;
  }
  return pdfjsModulePromise;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjs = await getPdfJs();
  const uint8 = new Uint8Array(buffer);
  const pdf = await pdfjs.getDocument({
    data: uint8,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;
  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((it) => ("str" in it ? it.str : ""))
        .join("");
      pageTexts.push(pageText);
    }
    return pageTexts.join("\n");
  } finally {
    await pdf.cleanup();
    await pdf.destroy();
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPasswordProtectedPdfError(error: unknown): boolean {
  const maybeNamed = error as { name?: unknown; code?: unknown };
  const name = typeof maybeNamed.name === "string" ? maybeNamed.name : "";
  const code = typeof maybeNamed.code === "string" ? maybeNamed.code : "";
  const message = getErrorMessage(error).toLowerCase();

  return (
    name === "PasswordException" ||
    code === "PasswordException" ||
    message.includes("password") ||
    message.includes("encrypted")
  );
}

function assessTextQuality(text: string): TextQuality {
  const compact = text.replace(/\s+/g, "");
  if (compact.length === 0) {
    return "empty";
  }
  if (compact.length < MIN_USABLE_TEXT_LENGTH) {
    return "empty";
  }

  const replacementCount = (compact.match(/\uFFFD/g) ?? []).length;
  const mojibakeHintCount = [...compact].filter((char) =>
    MOJIBAKE_HINT_CHARS.has(char)
  ).length;
  const controlCount = [...compact].filter((char) => {
    const code = char.charCodeAt(0);
    return code < 32 && char !== "\n" && char !== "\r" && char !== "\t";
  }).length;

  const replacementRatio = replacementCount / compact.length;
  const mojibakeHintRatio = mojibakeHintCount / compact.length;
  const controlRatio = controlCount / compact.length;

  if (
    replacementRatio > 0.02 ||
    controlRatio > 0.02 ||
    (mojibakeHintCount >= 12 && mojibakeHintRatio > 0.08)
  ) {
    return "garbled";
  }

  return "usable";
}

async function extractWithDocumentIntelligenceFallback(
  buffer: Buffer,
  reason: "empty" | "garbled" | "docx-layout"
): Promise<string | null> {
  if (!isDocumentIntelligenceConfigured()) {
    if (reason === "garbled") {
      throw new FileParseError(
        `文字化けを検出しました。OCR/レイアウト解析を使うには ${getDocumentIntelligenceMissingEnv().join(
          ", "
        )} を設定してください。`,
        "document-intelligence-not-configured"
      );
    }
    return null;
  }

  try {
    const text = await extractTextWithDocumentIntelligence(buffer);
    return text.trim() ? text : null;
  } catch (error) {
    throw new FileParseError(
      `Azure Document Intelligenceでの解析に失敗しました: ${getErrorMessage(error)}`,
      "document-intelligence-failed"
    );
  }
}

async function parsePdf(buffer: Buffer): Promise<string> {
  let text: string;

  try {
    text = await extractPdfText(buffer);
  } catch (error) {
    if (isPasswordProtectedPdfError(error)) {
      throw new FileParseError(
        "パスワード付きPDFは解析できません。パスワードを解除したPDFをアップロードしてください。",
        "password-protected-pdf"
      );
    }
    throw error;
  }

  const quality = assessTextQuality(text);
  if (quality === "usable") {
    return text;
  }

  const fallback = await extractWithDocumentIntelligenceFallback(buffer, quality);
  return fallback ?? text;
}

async function parseDocx(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  const text = result.value;

  if (!isDocumentIntelligenceConfigured()) {
    return text;
  }

  try {
    const fallback = await extractWithDocumentIntelligenceFallback(
      buffer,
      "docx-layout"
    );
    return fallback ?? text;
  } catch (error) {
    if (text.trim()) {
      console.warn("[parse-file] Document Intelligence DOCX fallback failed", error);
      return text;
    }
    throw error;
  }
}

/**
 * Buffer とファイル拡張子からテキストを抽出する。
 * ディスクI/Oを行わないため Vercel 等の読み取り専用環境でも動作する。
 */
export async function parseFile(buffer: Buffer, ext: string): Promise<string> {
  const normalizedExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  switch (normalizedExt) {
    case ".pdf":
      return parsePdf(buffer);
    case ".docx":
      return parseDocx(buffer);
    case ".txt":
      return buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file format: ${normalizedExt}`);
  }
}
