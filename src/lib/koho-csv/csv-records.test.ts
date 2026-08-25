import { describe, expect, it } from "vitest";

import { parseCsvRecords } from "./csv-records";
import type { KohoCsvLimits, ParsedCsvRecord } from "./types";

const DEFAULT_LIMITS: KohoCsvLimits = {
  maxCsvBytes: 100_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 50_000,
  maxRepeatedItemsPerRecord: 100,
};

function parseSuccessfully(
  text: string,
  limits: KohoCsvLimits = DEFAULT_LIMITS,
): ParsedCsvRecord[] {
  const result = parseCsvRecords(text, limits);
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`unexpected issue: ${result.issues[0]?.code ?? "unknown"}`);
  }
  return result.records;
}

describe("bounded koho CSV record parsing", () => {
  it("reconstructs exact raw records and physical line positions", () => {
    const records = parseSuccessfully('a,"b\r\nc"\r\nd,e\r\n');

    expect(records).toEqual([
      {
        ordinal: 1,
        startLine: 1,
        endLine: 2,
        rawRecord: 'a,"b\r\nc"',
        recordDelimiter: "\r\n",
        sourceCells: ["a", "b\r\nc"],
      },
      {
        ordinal: 2,
        startLine: 3,
        endLine: 3,
        rawRecord: "d,e",
        recordDelimiter: "\r\n",
        sourceCells: ["d", "e"],
      },
    ]);
  });

  it("preserves quoted comma, escaped quote, whitespace and formula text", () => {
    const records = parseSuccessfully(
      'one,"two,three","say ""hi""",," ",\t,=1+1\r\n',
    );

    expect(records[0].rawRecord).toBe(
      'one,"two,three","say ""hi""",," ",\t,=1+1',
    );
    expect(records[0].sourceCells).toEqual([
      "one",
      "two,three",
      'say "hi"',
      "",
      " ",
      "\t",
      "=1+1",
    ]);
  });

  it("accepts CRLF, LF, CR and mixed record delimiters", () => {
    const records = parseSuccessfully("a,b\r\nc,d\ne,f\rg,h");

    expect(records.map((record) => record.recordDelimiter)).toEqual([
      "\r\n",
      "\n",
      "\r",
      null,
    ]);
    expect(records.map((record) => record.rawRecord)).toEqual([
      "a,b",
      "c,d",
      "e,f",
      "g,h",
    ]);
    expect(records.map(({ startLine, endLine }) => [startLine, endLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it("does not create a record for a terminal delimiter", () => {
    expect(parseSuccessfully("a,b\r\n")).toHaveLength(1);
    expect(parseSuccessfully("a,b\n")).toHaveLength(1);
    expect(parseSuccessfully("a,b\r")).toHaveLength(1);
  });

  it("preserves an empty logical record between delimiters", () => {
    const records = parseSuccessfully("a,b\r\n\r\nc,d\r\n");

    expect(records).toHaveLength(3);
    expect(records[1]).toEqual({
      ordinal: 2,
      startLine: 2,
      endLine: 2,
      rawRecord: "",
      recordDelimiter: "\r\n",
      sourceCells: [""],
    });
  });

  it("counts quoted LF and CR as embedded physical newlines", () => {
    const records = parseSuccessfully('"a\nb\rc",d\r\nnext,row\r\n');

    expect(records[0]).toEqual(
      expect.objectContaining({
        startLine: 1,
        endLine: 3,
        rawRecord: '"a\nb\rc",d',
        sourceCells: ["a\nb\rc", "d"],
      }),
    );
    expect(records[1]).toEqual(
      expect.objectContaining({ startLine: 4, endLine: 4 }),
    );
  });

  it("maps malformed CSV to a fixed syntax issue without returning records", () => {
    const secretMarker = "FICTIONAL-SECRET-MARKER";
    const result = parseCsvRecords(`a,"${secretMarker}`, DEFAULT_LIMITS);

    expect(result).toEqual({
      ok: false,
      records: [],
      issues: [
        expect.objectContaining({
          code: "csv_syntax_error",
          status: "failed",
          message: "CSV syntax is invalid",
        }),
      ],
    });
    if (!result.ok) {
      expect(result.issues[0].message).not.toContain(secretMarker);
    }
  });

  it("enforces the record limit before publishing an overflowing record", () => {
    const result = parseCsvRecords("a\r\nb\r\n", {
      ...DEFAULT_LIMITS,
      maxRecords: 1,
    });

    expect(result).toEqual({
      ok: false,
      records: [],
      issues: [
        expect.objectContaining({
          code: "record_limit_exceeded",
          status: "failed",
          recordOrdinal: 2,
        }),
      ],
    });
  });

  it("enforces the column limit", () => {
    const result = parseCsvRecords("a,b,c\r\n", {
      ...DEFAULT_LIMITS,
      maxColumnsPerRecord: 2,
    });

    expect(result).toEqual({
      ok: false,
      records: [],
      issues: [
        expect.objectContaining({
          code: "column_limit_exceeded",
          status: "failed",
          recordOrdinal: 1,
        }),
      ],
    });
  });

  it("enforces cell characters by Unicode code point", () => {
    expect(
      parseCsvRecords("😀😀\r\n", {
        ...DEFAULT_LIMITS,
        maxCellCharacters: 1,
      }),
    ).toEqual({
      ok: false,
      records: [],
      issues: [
        expect.objectContaining({
          code: "cell_character_limit_exceeded",
          status: "failed",
          field: "sourceCells[0]",
        }),
      ],
    });

    expect(
      parseCsvRecords("😀😀\r\n", {
        ...DEFAULT_LIMITS,
        maxCellCharacters: 2,
        maxTotalCharacters: 2,
      }).ok,
    ).toBe(true);
  });

  it("enforces cumulative source-cell characters overflow-safely", () => {
    const result = parseCsvRecords("a,😀\r\n", {
      ...DEFAULT_LIMITS,
      maxTotalCharacters: 1,
    });

    expect(result).toEqual({
      ok: false,
      records: [],
      issues: [
        expect.objectContaining({
          code: "total_character_limit_exceeded",
          status: "failed",
          field: "sourceCells[1]",
        }),
      ],
    });
  });

  it("uses UTF-8 byte offsets without corrupting multibyte raw source", () => {
    const records = parseSuccessfully("架空,😀\r\n次,行\r\n");

    expect(records.map((record) => record.rawRecord)).toEqual([
      "架空,😀",
      "次,行",
    ]);
    expect(records.map((record) => record.sourceCells)).toEqual([
      ["架空", "😀"],
      ["次", "行"],
    ]);
  });

  it("logical record先頭のdata U+FEFFをrawRecordにも保持する", () => {
    const result = parseCsvRecords("A,B\r\n\uFEFFC,D\r\n", DEFAULT_LIMITS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.records[1].sourceCells[0]).toBe("\uFEFFC");
    expect(result.records[1].rawRecord).toBe("\uFEFFC,D");
  });
});
