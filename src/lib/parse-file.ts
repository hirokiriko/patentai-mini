import { extractText } from "unpdf";
import mammoth from "mammoth";

/**
 * Buffer とファイル拡張子からテキストを抽出する。
 * ディスクI/Oを行わないため Vercel 等の読み取り専用環境でも動作する。
 */
export async function parseFile(buffer: Buffer, ext: string): Promise<string> {
  const normalizedExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;

  switch (normalizedExt) {
    case ".pdf": {
      const { text } = await extractText(buffer);
      return text.join("\n");
    }
    case ".docx": {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }
    case ".txt": {
      return buffer.toString("utf-8");
    }
    default:
      throw new Error(`Unsupported file format: ${normalizedExt}`);
  }
}
