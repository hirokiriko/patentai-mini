import { createIssue } from "./issues";
import type {
  KohoCsvEncodingMetadata,
  KohoCsvIssue,
  KohoCsvLineEndingMetadata,
} from "./types";

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

interface KohoCsvDecodeBase {
  encoding: KohoCsvEncodingMetadata;
  issues: KohoCsvIssue[];
}

export interface KohoCsvDecodeSuccess extends KohoCsvDecodeBase {
  ok: true;
  text: string;
  lineEndings: KohoCsvLineEndingMetadata;
}

export interface KohoCsvDecodeFailure extends KohoCsvDecodeBase {
  ok: false;
  lineEndings: null;
}

export type KohoCsvDecodeResult =
  | KohoCsvDecodeSuccess
  | KohoCsvDecodeFailure;

export function decodeKohoCsv(bytes: Uint8Array): KohoCsvDecodeResult {
  const hasBom = hasUtf8Bom(bytes);
  const encoding: KohoCsvEncodingMetadata = {
    name: "utf-8",
    fatalDecode: true,
    bom: hasBom ? "utf8" : "none",
    byteLength: bytes.byteLength,
  };
  const issues: KohoCsvIssue[] = [];
  if (hasBom) {
    issues.push(createIssue("utf8_bom_present"));
  }

  const payload = hasBom ? bytes.subarray(UTF8_BOM.length) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      // The one inspected prefix is removed above. Preserve any later U+FEFF.
      ignoreBOM: true,
    }).decode(payload);
  } catch {
    issues.push(createIssue("invalid_utf8"));
    return { ok: false, encoding, lineEndings: null, issues };
  }

  const lineEndings = inspectLineEndings(text);
  if (text.length === 0) {
    issues.push(createIssue("empty_file"));
  } else {
    if (lineEndings.lfCount > 0 || lineEndings.crCount > 0) {
      issues.push(createIssue("unobserved_line_ending"));
    }
    if (!lineEndings.hasTerminalCrlf) {
      issues.push(createIssue("missing_terminal_crlf"));
    }
  }

  return { ok: true, encoding, text, lineEndings, issues };
}

export function inspectLineEndings(text: string): KohoCsvLineEndingMetadata {
  let crlfCount = 0;
  let lfCount = 0;
  let crCount = 0;

  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) {
        crlfCount += 1;
        index += 1;
      } else {
        crCount += 1;
      }
    } else if (codeUnit === 0x0a) {
      lfCount += 1;
    }
  }

  const usedStyles =
    Number(crlfCount > 0) + Number(lfCount > 0) + Number(crCount > 0);
  const style: KohoCsvLineEndingMetadata["style"] =
    usedStyles === 0
      ? "none"
      : usedStyles > 1
        ? "mixed"
        : crlfCount > 0
          ? "crlf"
          : lfCount > 0
            ? "lf"
            : "cr";

  return {
    style,
    crlfCount,
    lfCount,
    crCount,
    hasTerminalCrlf: text.endsWith("\r\n"),
  };
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  );
}
