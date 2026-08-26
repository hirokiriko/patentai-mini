import { describe, expect, it, vi } from "vitest";

import {
  parseKohoCsv,
  type KohoCsvContractIssueCode,
  type KohoCsvContractLimits,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
} from "./index";

const LIMITS: KohoCsvContractLimits = {
  maxInputBytes: 100_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 50_000,
};

function documentListCsv(publicationNumber = "FICTIONAL-0001"): string {
  return `JP,${publicationNumber},A,20990228\r\n`;
}

function parse(
  input: Omit<KohoCsvContractParseInput, "limits"> & {
    limits?: KohoCsvContractLimits;
  },
): KohoCsvContractParseResult {
  return parseKohoCsv({ ...input, limits: input.limits ?? LIMITS });
}

function codes(result: KohoCsvContractParseResult): KohoCsvContractIssueCode[] {
  return [
    ...result.issues.map((item) => item.code),
    ...result.records.flatMap((record) =>
      record.issues.map((item) => item.code),
    ),
  ];
}

function guardedInput(
  overrides: Partial<KohoCsvContractParseInput>,
): { input: KohoCsvContractParseInput; accesses: () => number } {
  let accesses = 0;
  const input = {
    packageType: "JPA",
    logicalFile: "document_list",
    entryPath: "DOCUMENT_LIST.csv",
    limits: LIMITS,
    get csv(): string {
      accesses += 1;
      throw new Error("CSV body must not be inspected");
    },
    ...overrides,
  } as KohoCsvContractParseInput;
  return { input, accesses: () => accesses };
}

describe("Issue #40 validation order", () => {
  it.each([
    ["invalid limits", { limits: { ...LIMITS, maxInputBytes: 0 } }, "invalid_limits"],
    ["unsafe path", { entryPath: "../DOCUMENT_LIST.csv" }, "unsafe_entry_path"],
    [
      "logical mismatch",
      { logicalFile: "abstract", entryPath: "DOCUMENT_LIST.csv" },
      "logical_file_mismatch",
    ],
  ] as const)("does not inspect CSV for %s", (_name, overrides, expectedCode) => {
    const guarded = guardedInput(overrides);
    const result = parseKohoCsv(guarded.input);

    expect(guarded.accesses()).toBe(0);
    expect(codes(result)).toEqual([expectedCode]);
    expect(result.recordCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.source.encoding).toEqual(
      expect.objectContaining({
        inputType: "not_inspected",
        byteLength: null,
        bom: "not_inspected",
      }),
    );
    expect(result.source.lineEndings).toBeNull();
  });

  it.each([
    "maxInputBytes",
    "maxRecords",
    "maxColumnsPerRecord",
    "maxCellCharacters",
    "maxTotalCharacters",
  ] as const)("rejects an invalid %s before reading source", (field) => {
    const guarded = guardedInput({ limits: { ...LIMITS, [field]: 0 } });
    const result = parseKohoCsv(guarded.input);

    expect(guarded.accesses()).toBe(0);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "invalid_limits", field }),
    ]);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 2 ** 53])(
    "rejects non-positive/non-finite/non-safe limit %s",
    (value) => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv: documentListCsv(),
        limits: { ...LIMITS, maxRecords: value },
      });
      expect(codes(result)).toEqual(["invalid_limits"]);
    },
  );

  it.each([
    "",
    "DOCUMENT_LIST.csv\0",
    "/DOCUMENT_LIST.csv",
    "\\DOCUMENT_LIST.csv",
    "//server/DOCUMENT_LIST.csv",
    "\\\\server\\DOCUMENT_LIST.csv",
    "C:/DOCUMENT_LIST.csv",
    "C:DOCUMENT_LIST.csv",
    "FOLDER/",
    "FOLDER\\",
    "FOLDER//DOCUMENT_LIST.csv",
    "FOLDER/./DOCUMENT_LIST.csv",
    "FOLDER/../DOCUMENT_LIST.csv",
  ])("rejects unsafe path %j", (entryPath) => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath,
      csv: documentListCsv(),
    });

    expect(codes(result)).toEqual(["unsafe_entry_path"]);
    expect(result.normalizedEntryPath).toBeNull();
    expect(result.source.encoding.byteLength).toBeNull();
  });

  it("uses case-sensitive basename matching", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "document_list.csv",
      csv: documentListCsv(),
    });

    expect(codes(result)).toEqual(["logical_file_mismatch"]);
    expect(result.source.encoding.byteLength).toBeNull();
  });
});

describe("Issue #40 bounded string preflight", () => {
  it.each([
    ["ASCII", "A", 1],
    ["two-byte", "¢", 2],
    ["three-byte", "界", 3],
    ["surrogate pair", "😀", 4],
  ] as const)("counts a %s scalar as %d UTF-8 bytes", (_name, scalar, width) => {
    const csv = documentListCsv(scalar);
    const exactBytes = 16 + width;
    const exact = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxInputBytes: exactBytes },
    });
    const exceeded = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxInputBytes: exactBytes - 1 },
    });

    expect(exact.status).toBe("success");
    expect(exact.source.encoding.byteLength).toBe(exactBytes);
    expect(codes(exceeded)).toEqual(["input_too_large"]);
    expect(exceeded.source.encoding.byteLength).toBeNull();
    expect(exceeded.source.encoding.bom).toBe("not_inspected");
  });

  it.each([
    ["lone high", "\uD800"],
    ["lone low", "\uDC00"],
    ["invalid pair", "\uD800A"],
  ])("rejects %s surrogate without replacement", (_name, csv) => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
    });

    expect(codes(result)).toEqual(["invalid_unicode_scalar"]);
    expect(result.source.encoding.byteLength).toBeNull();
    expect(result.source.encoding.bom).toBe("not_inspected");
    expect(result.source.lineEndings).toBeNull();
  });

  it("stops at an oversized valid prefix before a later lone surrogate", () => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const result = parse({
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv: "AA\uD800",
        limits: { ...LIMITS, maxInputBytes: 1 },
      });

      expect(codes(result)).toEqual(["input_too_large"]);
      expect(encode).not.toHaveBeenCalled();
    } finally {
      encode.mockRestore();
    }
  });

  it("encodes a valid string exactly once after bounded preflight", () => {
    const csv = documentListCsv();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      const result = parse({
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv,
      });

      expect(result.status).toBe("success");
      expect(encode).toHaveBeenCalledTimes(1);
      expect(encode).toHaveBeenCalledWith(csv);
    } finally {
      encode.mockRestore();
    }
  });
});

describe("Issue #40 BOM and strict UTF-8 ordering", () => {
  it("includes the BOM in maxInputBytes and does not inspect it after overflow", () => {
    const csv = `\uFEFF${documentListCsv()}`;
    const byteLength = 3 + documentListCsv().length;
    const exact = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxInputBytes: byteLength },
    });
    const exceeded = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxInputBytes: byteLength - 1 },
    });

    expect(exact.status).toBe("review_required");
    expect(exact.source.encoding).toEqual(
      expect.objectContaining({ byteLength, bom: "present" }),
    );
    expect(codes(exceeded)).toEqual(["input_too_large"]);
    expect(exceeded.source.encoding.bom).toBe("not_inspected");
  });

  it("removes exactly one leading BOM and preserves the second in source", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: `\uFEFF\uFEFF${documentListCsv()}`,
    });

    expect(result.source.encoding.bom).toBe("present");
    expect(result.records[0].sourceCells[0]).toBe("\uFEFFJP");
    expect(result.records[0].rawRecord.startsWith("\uFEFFJP,")).toBe(true);
    expect(codes(result)).toEqual(
      expect.arrayContaining(["bom_unexpected", "unknown_country_code"]),
    );
  });

  it("retains the BOM issue when bytes after it are invalid UTF-8", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: Uint8Array.from([0xef, 0xbb, 0xbf, 0xff]),
    });

    expect(result.issues.map((item) => item.code)).toEqual([
      "bom_unexpected",
      "invalid_utf8",
    ]);
    expect(result.status).toBe("failed");
    expect(result.source.encoding.bom).toBe("present");
    expect(result.source.lineEndings).toBeNull();
  });

  it("applies the BOM-inclusive byte boundary to Uint8Array input", () => {
    const bytes = new TextEncoder().encode(`\uFEFF${documentListCsv()}`);
    const exact = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: bytes,
      limits: { ...LIMITS, maxInputBytes: bytes.byteLength },
    });
    const exceeded = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: bytes,
      limits: { ...LIMITS, maxInputBytes: bytes.byteLength - 1 },
    });

    expect(exact.source.encoding).toEqual(
      expect.objectContaining({
        inputType: "uint8array",
        byteLength: bytes.byteLength,
        bom: "present",
      }),
    );
    expect(codes(exceeded)).toEqual(["input_too_large"]);
    expect(exceeded.source.encoding).toEqual(
      expect.objectContaining({
        inputType: "uint8array",
        byteLength: bytes.byteLength,
        bom: "not_inspected",
      }),
    );
  });
});

describe("Issue #40 line ending metadata", () => {
  it.each([
    ["LF-only", documentListCsv().replaceAll("\r\n", "\n"), "lf"],
    ["CR-only", documentListCsv().replaceAll("\r\n", "\r"), "cr"],
    [
      "mixed",
      `${documentListCsv("ONE")}${documentListCsv("TWO").replaceAll("\r\n", "\n")}`,
      "mixed",
    ],
  ] as const)("records %s as review_required", (_name, csv, style) => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
    });

    expect(result.status).toBe("review_required");
    expect(result.source.lineEndings?.style).toBe(style);
    expect(codes(result)).toContain("line_ending_unexpected");
    expect(codes(result)).not.toContain("missing_terminal_newline");
  });

  it("records a missing terminal newline without inventing a delimiter", () => {
    const csv = documentListCsv().slice(0, -2);
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
    });

    expect(result.status).toBe("review_required");
    expect(result.source.lineEndings).toEqual(
      expect.objectContaining({
        style: "none",
        hasTerminalNewline: false,
        hasTerminalCrlf: false,
      }),
    );
    expect(codes(result)).toContain("missing_terminal_newline");
    expect(result.records[0].rawRecord).toBe(csv);
  });
});

describe("Issue #40 raw-source character and parser limits", () => {
  it("counts commas, source quotes, escaped quotes, CRLF, and emoji", () => {
    const csv = 'JP,"😀,""B""",A,20990228\r\n';
    const exactCharacters = Array.from(csv).length;
    const exact = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxTotalCharacters: exactCharacters },
    });
    const exceeded = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, maxTotalCharacters: exactCharacters - 1 },
    });

    expect(exact.status).toBe("success");
    expect(exact.records[0].sourceCells[1]).toBe('😀,"B"');
    expect(codes(exceeded)).toEqual(["total_character_limit"]);
    expect(exceeded.recordCount).toBe(0);
    expect(exceeded.source.lineEndings).toBeNull();
  });

  it("excludes one transport BOM but counts a second U+FEFF", () => {
    const source = documentListCsv();
    const oneBom = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: `\uFEFF${source}`,
      limits: { ...LIMITS, maxTotalCharacters: Array.from(source).length },
    });
    const twoBom = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: `\uFEFF\uFEFF${source}`,
      limits: { ...LIMITS, maxTotalCharacters: Array.from(source).length },
    });

    expect(codes(oneBom)).not.toContain("total_character_limit");
    expect(codes(twoBom)).toContain("total_character_limit");
    expect(twoBom.source.lineEndings).toBeNull();
  });

  it.each([
    ["record_limit", `${documentListCsv("ONE")}${documentListCsv("TWO")}`, { maxRecords: 1 }],
    ["column_limit", documentListCsv(), { maxColumnsPerRecord: 3 }],
    ["cell_length_limit", documentListCsv("LONG"), { maxCellCharacters: 3 }],
  ] as const)("enforces %s", (expectedCode, csv, override) => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
      limits: { ...LIMITS, ...override },
    });

    expect(result.status).toBe("failed");
    expect(codes(result)).toContain(expectedCode);
    expect(result.records).toEqual([]);
  });

  it("does not copy source contents into issue messages", () => {
    const marker = "FICTIONAL-SENSITIVE-MARKER";
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: `"${marker}\r\n`,
    });

    expect(codes(result)).toContain("csv_malformed");
    for (const item of result.issues) {
      expect(item.message).not.toContain(marker);
    }
  });
});
