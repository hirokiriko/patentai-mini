import { parse } from "csv-parse/sync";
import type { InfoRecord, Options } from "csv-parse/sync";

import { createIssue } from "./issues";
import { countCodePoints } from "./scalar";
import type {
  KohoCsvIssue,
  KohoCsvIssueCode,
  KohoCsvLimits,
  ParsedCsvRecord,
} from "./types";

type CsvRecordLimitCode = Extract<
  KohoCsvIssueCode,
  | "record_limit_exceeded"
  | "column_limit_exceeded"
  | "cell_character_limit_exceeded"
  | "total_character_limit_exceeded"
>;

export type ParsedCsvRecordsResult =
  | { ok: true; records: ParsedCsvRecord[] }
  | { ok: false; records: []; issues: KohoCsvIssue[] };

class CsvRecordLimitAbort extends Error {
  constructor(readonly issue: KohoCsvIssue) {
    super("CSV record parsing stopped at a configured limit");
    this.name = "CsvRecordLimitAbort";
  }
}

function abortAtLimit(
  code: CsvRecordLimitCode,
  recordOrdinal: number,
  field?: string,
): never {
  throw new CsvRecordLimitAbort(
    createIssue(code, {
      recordOrdinal,
      ...(field === undefined ? {} : { field }),
    }),
  );
}

function recordDelimiterFor(
  bytes: Uint8Array,
): ParsedCsvRecord["recordDelimiter"] {
  const length = bytes.byteLength;
  if (
    length >= 2 &&
    bytes[length - 2] === 0x0d &&
    bytes[length - 1] === 0x0a
  ) {
    return "\r\n";
  }
  if (length >= 1 && bytes[length - 1] === 0x0a) return "\n";
  if (length >= 1 && bytes[length - 1] === 0x0d) return "\r";
  return null;
}

function delimiterByteLength(
  delimiter: ParsedCsvRecord["recordDelimiter"],
): number {
  if (delimiter === "\r\n") return 2;
  return delimiter === null ? 0 : 1;
}

function lineBreakCount(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\r") {
      if (value[index + 1] === "\n") index += 1;
      count += 1;
    } else if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

/**
 * Parse already validated, BOM-free UTF-8 text into bounded source records.
 * `csv-parse`'s own `raw` value omits only part of a CRLF delimiter, so raw
 * logical records are reconstructed from its cumulative byte position.
 */
export function parseCsvRecords(
  text: string,
  limits: KohoCsvLimits,
): ParsedCsvRecordsResult {
  return parseCsvRecordsFromUtf8Bytes(
    new TextEncoder().encode(text),
    limits,
  );
}

/**
 * Parse text using its already-available, BOM-free UTF-8 representation.
 * The Issue #40 string adapter uses this entry point so its one bounded
 * post-preflight encoding is reused for source-record reconstruction.
 */
export function parseCsvRecordsFromUtf8Bytes(
  bytes: Uint8Array,
  limits: KohoCsvLimits,
): ParsedCsvRecordsResult {
  // The file-level decoder has already removed only the leading transport BOM.
  // Preserve any later U+FEFF that happens to begin a logical record.
  const decoder = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  });
  const records: ParsedCsvRecord[] = [];
  let previousByteOffset = 0;
  let nextStartLine = 1;
  let totalCharacters = 0;

  const options: Options = {
    columns: false,
    delimiter: ",",
    quote: '"',
    escape: '"',
    record_delimiter: ["\r\n", "\n", "\r"],
    relax_column_count: true,
    skip_empty_lines: false,
    trim: false,
    ltrim: false,
    rtrim: false,
    info: false,
    raw: false,
    on_record(sourceCells: string[], context: InfoRecord) {
      const ordinal = records.length + 1;
      if (ordinal > limits.maxRecords) {
        abortAtLimit("record_limit_exceeded", ordinal);
      }
      if (sourceCells.length > limits.maxColumnsPerRecord) {
        abortAtLimit("column_limit_exceeded", ordinal);
      }

      for (let index = 0; index < sourceCells.length; index += 1) {
        const cellCharacters = countCodePoints(sourceCells[index]);
        const field = `sourceCells[${index}]`;
        if (cellCharacters > limits.maxCellCharacters) {
          abortAtLimit(
            "cell_character_limit_exceeded",
            ordinal,
            field,
          );
        }
        if (cellCharacters > limits.maxTotalCharacters - totalCharacters) {
          abortAtLimit(
            "total_character_limit_exceeded",
            ordinal,
            field,
          );
        }
        totalCharacters += cellCharacters;
      }

      const currentByteOffset = context.bytes;
      const rawWithDelimiterBytes = bytes.subarray(
        previousByteOffset,
        currentByteOffset,
      );
      const recordDelimiter = recordDelimiterFor(rawWithDelimiterBytes);
      const rawBytes = rawWithDelimiterBytes.subarray(
        0,
        rawWithDelimiterBytes.byteLength -
          delimiterByteLength(recordDelimiter),
      );
      const rawRecord = decoder.decode(rawBytes);
      const startLine = nextStartLine;
      const endLine = startLine + lineBreakCount(rawRecord);

      records.push({
        ordinal,
        startLine,
        endLine,
        rawRecord,
        recordDelimiter,
        sourceCells: [...sourceCells],
      });

      previousByteOffset = currentByteOffset;
      nextStartLine =
        recordDelimiter === null ? endLine : endLine + 1;

      // Keep csv-parse's own result array empty; bounded records live above.
      return null;
    },
  };

  try {
    parse(bytes, options);
    return { ok: true, records };
  } catch (error) {
    if (error instanceof CsvRecordLimitAbort) {
      return { ok: false, records: [], issues: [error.issue] };
    }
    return {
      ok: false,
      records: [],
      issues: [createIssue("csv_syntax_error")],
    };
  }
}

export { countCodePoints } from "./scalar";
