import mammoth from "mammoth";
import path from "node:path";

// pdfjs-dist は Node 実行時に require("@napi-rs/canvas") で DOMMatrix 等を
// polyfill する。Vercel Lambda に自動追跡させるため、side-effect import で
// 明示的に参照しておく。
import "@napi-rs/canvas";

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

// pdfjs-dist の Node ビルドは `file://` URL ではなく生のパスを要求する
// （内部で fs.promises.readFile(url) を直接呼ぶため）。
// pnpm の node_modules/pdfjs-dist は symlink なので Vercel の
// outputFileTracingIncludes が壊れる。postinstall で vendor/ に
// 実ファイルを複製し、そこを参照する。
const PDFJS_ASSETS_ROOT = path.join(process.cwd(), "vendor", "pdfjs-dist");
const CMAP_URL = path.join(PDFJS_ASSETS_ROOT, "cmaps") + path.sep;
const STANDARD_FONT_DATA_URL = path.join(PDFJS_ASSETS_ROOT, "standard_fonts") + path.sep;

let pdfjsModulePromise: Promise<PdfJsModule> | null = null;
function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsModulePromise) {
    pdfjsModulePromise = import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjsModulePromise;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjs = await getPdfJs();
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
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

/**
 * Buffer とファイル拡張子からテキストを抽出する。
 * ディスクI/Oを行わないため Vercel 等の読み取り専用環境でも動作する。
 */
export async function parseFile(buffer: Buffer, ext: string): Promise<string> {
  const normalizedExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  switch (normalizedExt) {
    case ".pdf":
      return extractPdfText(buffer);
    case ".docx": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case ".txt":
      return buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file format: ${normalizedExt}`);
  }
}
