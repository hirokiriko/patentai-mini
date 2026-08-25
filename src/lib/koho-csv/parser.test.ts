import { describe, expect, expectTypeOf, it } from "vitest";

import { parseKohoCsv } from "./index";
import {
  FICTIONAL_LIMITS,
  fictionalAbstractCsv,
  fictionalCsvBytes,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-csv";
import type {
  KohoCsvLimits,
  KohoCsvLogicalFile,
  KohoCsvParseResult,
} from "./types";

function issueCodes(result: ReturnType<typeof parseKohoCsv>) {
  return result.issues.map((issue) => issue.code);
}

describe("parseKohoCsv validation order", () => {
  it("公開resultをstatusで型narrowingできる", () => {
    const assertNarrowing = (result: KohoCsvParseResult) => {
      if (result.status === "unsupported_type") {
        expectTypeOf(result.logicalFile).toEqualTypeOf<null>();
        expectTypeOf(result.records).toEqualTypeOf<[]>();
      } else if (
        result.status === "success" ||
        result.status === "review_required"
      ) {
        expectTypeOf(result.logicalFile).toEqualTypeOf<KohoCsvLogicalFile>();
      }
    };
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "FICTIONAL-UNKNOWN.csv",
      bytes: Uint8Array.from([0xff]),
      limits: FICTIONAL_LIMITS,
    });

    assertNarrowing(result);
    expect(result.status).toBe("unsupported_type");
  });

  it.each([
    "maxCsvBytes",
    "maxRecords",
    "maxColumnsPerRecord",
    "maxCellCharacters",
    "maxTotalCharacters",
    "maxRepeatedItemsPerRecord",
  ] as const)("invalid %sではpathも本文も調べない", (field) => {
    const invalidLimits = { ...FICTIONAL_LIMITS, [field]: 0 };
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "../FICTIONAL-UNSAFE.csv",
      bytes: Uint8Array.from([0xff]),
      limits: invalidLimits,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        logicalFile: null,
        normalizedEntryPath: null,
        recordCount: 0,
        records: [],
        encoding: expect.objectContaining({ bom: "not_inspected" }),
        lineEndings: null,
      }),
    );
    expect(issueCodes(result)).toEqual(["invalid_limits"]);
  });

  it.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "invalid maxRecords %sをresultへ分類する",
    (maxRecords) => {
      const result = parseKohoCsv({
        packageType: "JPA",
        entryPath: "ABSTRACT.csv",
        bytes: fictionalCsvBytes(fictionalAbstractCsv("JPA")),
        limits: { ...FICTIONAL_LIMITS, maxRecords },
      });
      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toEqual(["invalid_limits"]);
    },
  );

  it("unsupported pathではoversize・invalid UTF-8をdecodeしない", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT/P_A5/CONTENTS1.csv",
      bytes: Uint8Array.from([0xff, 0xff]),
      limits: { ...FICTIONAL_LIMITS, maxCsvBytes: 1 },
    });

    expect(result.status).toBe("unsupported_type");
    expect(result.logicalFile).toBeNull();
    expect(result.normalizedEntryPath).toBe(
      "DOCUMENT/P_A5/CONTENTS1.csv",
    );
    expect(result.encoding.bom).toBe("not_inspected");
    expect(result.lineEndings).toBeNull();
    expect(result.recordCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(issueCodes(result)).toEqual(["unsupported_entry_placement"]);
  });

  it("prototype由来basenameでもunknown fileとしてdecodeしない", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT/P_A1/toString",
      bytes: Uint8Array.from([0xff, 0xff]),
      limits: { ...FICTIONAL_LIMITS, maxCsvBytes: 1 },
    });

    expect(result.status).toBe("unsupported_type");
    expect(result.logicalFile).toBeNull();
    expect(result.encoding.bom).toBe("not_inspected");
    expect(result.recordCount).toBe(0);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "unsupported_logical_file",
    ]);
  });

  it("unsafe pathではoversize・invalid UTF-8をdecodeしない", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "../FICTIONAL-UNSAFE/ABSTRACT.csv",
      bytes: Uint8Array.from([0xff, 0xff]),
      limits: { ...FICTIONAL_LIMITS, maxCsvBytes: 1 },
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        logicalFile: null,
        normalizedEntryPath: null,
        recordCount: 0,
        records: [],
        encoding: expect.objectContaining({ bom: "not_inspected" }),
        lineEndings: null,
      }),
    );
    expect(issueCodes(result)).toEqual(["unsafe_entry_path"]);
  });

  it("package-section mismatchでは本文をdecodeしない", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT/P_B1/CONTENTS2.csv",
      bytes: Uint8Array.from([0xff]),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("failed");
    expect(result.logicalFile).toBe("CONTENTS2");
    expect(result.normalizedEntryPath).toBe("DOCUMENT/P_B1/CONTENTS2.csv");
    expect(result.encoding.bom).toBe("not_inspected");
    expect(result.lineEndings).toBeNull();
    expect(issueCodes(result)).toEqual(["package_section_mismatch"]);
  });

  it("対象pathではbyte limitをdecodeより先に検査する", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "ABSTRACT.csv",
      bytes: Uint8Array.from([0xff, 0xff]),
      limits: { ...FICTIONAL_LIMITS, maxCsvBytes: 1 },
    });

    expect(result.status).toBe("failed");
    expect(result.logicalFile).toBe("ABSTRACT");
    expect(result.encoding.bom).toBe("not_inspected");
    expect(issueCodes(result)).toEqual(["csv_byte_limit_exceeded"]);
  });
});

describe("parseKohoCsv source metadata", () => {
  it("fatal UTF-8 failureではline metadataとrecordを返さない", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: Uint8Array.from([0xff]),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("failed");
    expect(result.logicalFile).toBe("DOCUMENT_LIST");
    expect(result.encoding).toEqual({
      name: "utf-8",
      fatalDecode: true,
      bom: "none",
      byteLength: 1,
    });
    expect(result.lineEndings).toBeNull();
    expect(result.recordCount).toBe(0);
    expect(issueCodes(result)).toContain("invalid_utf8");
  });

  it("UTF-8 BOMを除いてparseしreview_requiredにする", () => {
    const payload = fictionalCsvBytes(fictionalDocumentListCsv("JPA"));
    const bytes = new Uint8Array(payload.length + 3);
    bytes.set([0xef, 0xbb, 0xbf]);
    bytes.set(payload, 3);
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes,
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("review_required");
    expect(result.encoding.bom).toBe("utf8");
    expect(result.recordCount).toBe(1);
    expect(issueCodes(result)).toContain("utf8_bom_present");
    expect(result.records[0].rawRecord.startsWith("JP,")).toBe(true);
  });

  it.each([
    ["lf", "\n", "lf"],
    ["cr", "\r", "cr"],
  ] as const)("%s-onlyをmetadata付きreviewへする", (_label, newline, style) => {
    const csv = fictionalDocumentListCsv("JPA").replace(/\r\n/g, newline);
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: fictionalCsvBytes(csv),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("review_required");
    expect(result.lineEndings?.style).toBe(style);
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["unobserved_line_ending", "missing_terminal_crlf"]),
    );
  });

  it("mixed newlineとquoted field内LFをsource全体で数える", () => {
    const csv =
      'JP,"FICTIONAL\nPUBLICATION",A,20990228\r\n' +
      "JP,FICTIONAL-PUBLICATION-2,A5,20990301\r";
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: fictionalCsvBytes(csv),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("review_required");
    expect(result.lineEndings).toEqual({
      style: "mixed",
      crlfCount: 1,
      lfCount: 1,
      crCount: 1,
      hasTerminalCrlf: false,
    });
    expect(result.records[0]).toEqual(
      expect.objectContaining({ startLine: 1, endLine: 2 }),
    );
  });

  it("終端CRLFなしだけでもreview_requiredにする", () => {
    const csv = fictionalDocumentListCsv("JPA").slice(0, -2);
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: fictionalCsvBytes(csv),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("review_required");
    expect(result.lineEndings?.style).toBe("none");
    expect(issueCodes(result)).toEqual(["missing_terminal_crlf"]);
  });
});

describe("parseKohoCsv syntax and resource limits", () => {
  function parseWith(
    csv: string,
    limits: KohoCsvLimits = FICTIONAL_LIMITS,
  ) {
    return parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: fictionalCsvBytes(csv),
      limits,
    });
  }

  it("0 byteとBOM-onlyをempty_fileへ分類する", () => {
    const empty = parseWith("");
    const bomOnly = parseKohoCsv({
      packageType: "JPA",
      entryPath: "DOCUMENT_LIST.csv",
      bytes: Uint8Array.from([0xef, 0xbb, 0xbf]),
      limits: FICTIONAL_LIMITS,
    });

    expect(empty.status).toBe("failed");
    expect(issueCodes(empty)).toEqual(
      expect.arrayContaining(["empty_file", "required_record_missing"]),
    );
    expect(
      empty.issues
        .filter((issue) => issue.code === "required_record_missing")
        .map((issue) => issue.field),
    ).toEqual(["records"]);
    expect(bomOnly.status).toBe("failed");
    expect(bomOnly.encoding.bom).toBe("utf8");
    expect(issueCodes(bomOnly)).toEqual(
      expect.arrayContaining([
        "utf8_bom_present",
        "empty_file",
        "required_record_missing",
      ]),
    );
  });

  it("空ABSTRACTではmetadataとsummaryの両欠落を保持する", () => {
    const result = parseKohoCsv({
      packageType: "JPA",
      entryPath: "ABSTRACT.csv",
      bytes: fictionalCsvBytes(""),
      limits: FICTIONAL_LIMITS,
    });

    expect(result.status).toBe("failed");
    expect(
      result.issues
        .filter((issue) => issue.code === "required_record_missing")
        .map((issue) => issue.field),
    ).toEqual(["metadata", "summary"]);
  });

  it("空logical recordをskipしない", () => {
    const result = parseWith("\r\n");

    expect(result.status).toBe("failed");
    expect(result.recordCount).toBe(1);
    expect(result.records[0].rawRecord).toBe("");
    expect(result.records[0].issues.map((issue) => issue.code)).toContain(
      "empty_record",
    );
  });

  it("CSV syntax errorでは推測recordを返さない", () => {
    const result = parseWith('JP,"FICTIONAL-SECRET,A,20990228\r\n');

    expect(result.status).toBe("failed");
    expect(result.recordCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(issueCodes(result)).toContain("csv_syntax_error");
  });

  it.each([
    [
      "record_limit_exceeded",
      fictionalDocumentListCsv("JPA") + fictionalDocumentListCsv("JPA"),
      { maxRecords: 1 },
    ],
    [
      "column_limit_exceeded",
      fictionalDocumentListCsv("JPA"),
      { maxColumnsPerRecord: 3 },
    ],
    [
      "cell_character_limit_exceeded",
      fictionalDocumentListCsv("JPA"),
      { maxCellCharacters: 2 },
    ],
    [
      "total_character_limit_exceeded",
      fictionalDocumentListCsv("JPA"),
      { maxTotalCharacters: 3 },
    ],
  ] as const)("%sで安全にrecordを破棄する", (code, csv, override) => {
    const result = parseWith(csv, { ...FICTIONAL_LIMITS, ...override });

    expect(result.status).toBe("failed");
    expect(result.recordCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(issueCodes(result)).toContain(code);
  });
});
