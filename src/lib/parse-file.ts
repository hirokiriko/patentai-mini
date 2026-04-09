import { readFile } from "fs/promises";
import { extname } from "path";
import { extractText } from "unpdf";
import mammoth from "mammoth";

export async function parseFile(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const buffer = await readFile(filePath);

  switch (ext) {
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
      throw new Error(`Unsupported file format: ${ext}`);
  }
}
