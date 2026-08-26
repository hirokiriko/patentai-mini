import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseKohoCsv,
  type KohoCsvContractLimits,
  type KohoCsvContractLogicalFile,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
  type KohoCsvContractStatus,
} from "./index";
import {
  fictionalAbstractCsv,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-csv";

const LIMITS: KohoCsvContractLimits = {
  maxInputBytes: 100_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 50_000,
};

function issueCodes(result: KohoCsvContractParseResult): string[] {
  return [
    ...result.issues.map((item) => item.code),
    ...result.records.flatMap((record) => record.issues.map((item) => item.code)),
  ];
}

function encodeCell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function rawRecord(cells: readonly string[]): string {
  return cells.map(encodeCell).join(",");
}

function withStableRecordLength(cells: readonly string[]): string[] {
  const stable = [...cells];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const value = String(Array.from(rawRecord(stable)).length + 1);
    if (stable[0] === value) return stable;
    stable[0] = value;
  }
  throw new Error("fictional record length did not stabilize");
}

function contents1Csv(): string {
  const cells = withStableRecordLength([
    "0",
    "A1",
    "FICTIONAL-PUBLICATION-0001",
    "FICTIONAL-APPLICATION-0001",
    "0",
    "0",
    "3",
    "架空😀",
    "1",
    "3",
    "架空地",
    "FICTIONAL-PARTY-0001",
    "3",
    "架空者",
  ]);
  return `${rawRecord(cells)}\r\n`;
}

function contents2Csv(packageType: "JPA" | "JPB", forceMismatch = false): string {
  const base = [
    "0",
    "A1",
    "FICTIONAL-PUBLICATION-0001",
    ...(packageType === "JPB" ? ["20990228"] : []),
    "FICTIONAL-APPLICATION-0001",
    "0",
    " ",
    " ",
    " ",
    " ",
    " ",
    " ",
    " ",
    "G06F",
    "架空題名",
    "架空地",
    "FICTIONAL-PARTY-0001",
    "架空者",
  ];
  const cells = forceMismatch ? base : withStableRecordLength(base);
  if (forceMismatch) cells[0] = "1";
  return `${rawRecord(cells)}\r\n`;
}

function parse(
  input: Omit<KohoCsvContractParseInput, "limits"> & {
    limits?: KohoCsvContractLimits;
  },
) {
  return parseKohoCsv({ ...input, limits: input.limits ?? LIMITS });
}

describe("Issue #40 public contract", () => {
  it("exports the lowercase logical-file and three-state contract", () => {
    expectTypeOf<KohoCsvContractLogicalFile>().toEqualTypeOf<
      "abstract" | "document_list" | "contents1" | "contents2"
    >();
    expectTypeOf<KohoCsvContractStatus>().toEqualTypeOf<
      "success" | "review_required" | "failed"
    >();
  });

  it("accepts string input and preserves ABSTRACT source plus semantic view", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "ABSTRACT.csv",
      csv: fictionalAbstractCsv("JPA"),
    });

    expect(result.status).toBe("success");
    expect(result.logicalFile).toBe("abstract");
    expect(result.source).toEqual(
      expect.objectContaining({
        delimiter: ",",
        encoding: expect.objectContaining({ inputType: "string", bom: "absent" }),
        lineEndings: expect.objectContaining({ style: "crlf", hasTerminalCrlf: true }),
      }),
    );
    expect(result.recordCount).toBe(2);
    expect(result.records[0]).toEqual(
      expect.objectContaining({
        recordNumber: 1,
        sourceCells: ["JPA", "20990228", "FICTIONAL-ISSUE-0001", "01122"],
        semantic: expect.objectContaining({ issueControlValue: "01122" }),
      }),
    );
    expect(issueCodes(result)).not.toContain("opaque_control_value");
  });

  it("accepts Uint8Array with fatal UTF-8 validation", () => {
    const valid = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: new TextEncoder().encode(fictionalDocumentListCsv("JPA")),
    });
    expect(valid.status).toBe("success");
    expect(valid.source.encoding.inputType).toBe("uint8array");

    const invalid = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: Uint8Array.from([0xff]),
    });
    expect(invalid.status).toBe("failed");
    expect(issueCodes(invalid)).toContain("invalid_utf8");
  });

  it("checks all limits before path/decode and enforces input-wide character limits", () => {
    const invalidLimits = parse({
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "../ABSTRACT.csv",
      csv: Uint8Array.from([0xff]),
      limits: { ...LIMITS, maxInputBytes: 0 },
    });
    expect(invalidLimits.normalizedEntryPath).toBeNull();
    expect(issueCodes(invalidLimits)).toEqual(["invalid_limits"]);

    const tooManyCharacters = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: fictionalDocumentListCsv("JPA"),
      limits: { ...LIMITS, maxTotalCharacters: 5 },
    });
    expect(tooManyCharacters.status).toBe("failed");
    expect(issueCodes(tooManyCharacters)).toContain("total_character_limit");
  });

  it("separates unsafe path, logical-file mismatch, and safe unexpected placement", () => {
    const unsafe = parse({
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "../ABSTRACT.csv",
      csv: fictionalAbstractCsv("JPA"),
    });
    expect(issueCodes(unsafe)).toEqual(["unsafe_entry_path"]);

    const mismatch = parse({
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "DOCUMENT_LIST.csv",
      csv: fictionalAbstractCsv("JPA"),
    });
    expect(issueCodes(mismatch)).toEqual(["logical_file_mismatch"]);

    const misplaced = parse({
      packageType: "JPA",
      logicalFile: "contents1",
      entryPath: "DOCUMENT/P_A5/CONTENTS1.csv",
      csv: contents1Csv(),
    });
    expect(misplaced.status).toBe("review_required");
    expect(issueCodes(misplaced)).toContain("unexpected_file_location");
    expect(misplaced.recordCount).toBe(1);
  });

  it("records BOM/newline variations without treating a terminal LF as missing", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: `\uFEFF${fictionalDocumentListCsv("JPA").replace(/\r\n/g, "\n")}`,
    });
    expect(result.status).toBe("review_required");
    expect(result.source.encoding.bom).toBe("present");
    expect(result.source.lineEndings?.style).toBe("lf");
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["bom_unexpected", "line_ending_unexpected"]),
    );
    expect(issueCodes(result)).not.toContain("missing_terminal_newline");
  });

  it("keeps package-code and known cross-package kind mismatches reviewable", () => {
    const abstract = parse({
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "ABSTRACT.csv",
      csv: fictionalAbstractCsv("JPA").replace(/^JPA,/, "JPB,"),
    });
    expect(abstract.status).toBe("review_required");
    expect(issueCodes(abstract)).toContain("unknown_package_code");
    expect(abstract.records[0].semantic).toEqual(
      expect.objectContaining({ packageCode: "JPB" }),
    );

    const documentList = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv: "JP,FICTIONAL-PUBLICATION-0001,B1,20990228\r\n",
    });
    expect(documentList.status).toBe("review_required");
    expect(issueCodes(documentList)).toContain("unknown_kind_code");
    expect(documentList.records[0].semantic).not.toBeNull();
  });

  it("parses CONTENTS1 counts and Unicode lengths through the new API", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "contents1",
      entryPath: "DOCUMENT/P_A1/CONTENTS1.csv",
      csv: contents1Csv(),
    });
    expect(result.status).toBe("success");
    expect(result.records[0].semantic).toEqual(
      expect.objectContaining({
        title: "架空😀",
        displayFlags: [],
        displayClassifications: [],
        applicants: [expect.objectContaining({ applicantName: "架空者" })],
      }),
    );
  });

  it("parses CONTENTS2 slots and exposes nulls only in the semantic slot view", () => {
    const result = parse({
      packageType: "JPA",
      logicalFile: "contents2",
      entryPath: "DOCUMENT/P_P1/CONTENTS2.csv",
      csv: contents2Csv("JPA"),
    });
    expect(result.status).toBe("success");
    expect(result.records[0].sourceCells.slice(5, 12)).toEqual(Array(7).fill(" "));
    expect(result.records[0].semantic).toEqual(
      expect.objectContaining({ semanticDisplaySlots: Array(7).fill(null) }),
    );
  });

  it("treats only a JPB CONTENTS2 candidate-length difference as review_required", () => {
    const result = parse({
      packageType: "JPB",
      logicalFile: "contents2",
      entryPath: "DOCUMENT/P_B1/CONTENTS2.csv",
      csv: contents2Csv("JPB", true),
    });
    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("record_length_mismatch");
    expect(result.records[0].issues.find((item) => item.code === "record_length_mismatch")?.status).toBe(
      "review_required",
    );
  });

  it("keeps quoted commas, escaped quotes, and embedded CRLF inside one source record", () => {
    const csv = 'JP,"FICTIONAL,\"\"PUBLICATION\"\"\r\nLINE",A,20990228\r\n';
    const result = parse({
      packageType: "JPA",
      logicalFile: "document_list",
      entryPath: "DOCUMENT_LIST.csv",
      csv,
    });
    expect(result.recordCount).toBe(1);
    expect(result.records[0].sourceCells[1]).toBe('FICTIONAL,"PUBLICATION"\r\nLINE');
    expect(result.records[0].rawRecord).toContain('"FICTIONAL,');
    expect(result.source.lineEndings?.crlfCount).toBe(2);
  });
});
