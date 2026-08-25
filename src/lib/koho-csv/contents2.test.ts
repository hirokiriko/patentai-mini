import { describe, expect, it } from "vitest";

import { parseContents2Records } from "./parse-contents2";
import type {
  KohoCsvLimits,
  KohoCsvPackageType,
  ParsedCsvRecord,
} from "./types";

const DEFAULT_LIMITS: KohoCsvLimits = {
  maxCsvBytes: 1_000_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 100_000,
  maxRepeatedItemsPerRecord: 10,
};

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function encodeCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

function rawRecord(cells: readonly string[]): string {
  return cells.map(encodeCell).join(",");
}

function withStableRecordLength(cells: readonly string[]): string[] {
  const result = [...cells];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const computed = String(codePointLength(rawRecord(result)) + 1);
    if (result[0] === computed) return result;
    result[0] = computed;
  }
  throw new Error("fictional CONTENTS2 record length did not stabilize");
}

function parsedRecord(
  cells: readonly string[],
  ordinal = 1,
): ParsedCsvRecord {
  const stableCells = withStableRecordLength(cells);
  return {
    ordinal,
    startLine: ordinal,
    endLine: ordinal,
    rawRecord: rawRecord(stableCells),
    recordDelimiter: "\r\n",
    sourceCells: stableCells,
  };
}

function withWrongRecordLength(record: ParsedCsvRecord): ParsedCsvRecord {
  const sourceCells = [...record.sourceCells];
  sourceCells[0] = String(Number(sourceCells[0]) + 1);
  return {
    ...record,
    sourceCells,
    rawRecord: rawRecord(sourceCells),
  };
}

function jpaCells(publicationNumber = "FICTIONAL-PUB-0001"): string[] {
  return [
    "0",
    "P_A1",
    publicationNumber,
    "FICTIONAL-APP-0001",
    "1",
    "請",
    " ",
    " ",
    " ",
    " ",
    " ",
    " ",
    "FICTIONAL-CLASS-1",
    "架空発明",
    "",
    "00001",
    "",
  ];
}

function jpbCells(publicationNumber = "FICTIONAL-PUB-B-0001"): string[] {
  return [
    "0",
    "P_B1",
    publicationNumber,
    "20990228",
    "FICTIONAL-APP-B-0001",
    "2",
    "早",
    "際",
    " ",
    " ",
    " ",
    " ",
    " ",
    "FICTIONAL-CLASS-B-1",
    "架空登録発明",
    "架空所在地",
    "00002",
    "架空権利者",
  ];
}

function parse(
  packageType: KohoCsvPackageType,
  records: ParsedCsvRecord[],
) {
  return parseContents2Records({
    packageType,
    records,
    limits: DEFAULT_LIMITS,
  });
}

function issueCodes(result: ReturnType<typeof parseContents2Records>) {
  return result.records.flatMap((record) =>
    record.issues.map((issue) => issue.code),
  );
}

describe("parseContents2Records", () => {
  it("JPA 17列を正式property名とlossy metadataへ投影する", () => {
    const record = parsedRecord(jpaCells());
    const result = parse("JPA", [record]);

    expect(result.status).toBe("success");
    expect(result.records[0].sourceCells).toEqual(record.sourceCells);
    expect(result.records[0].projection).toMatchObject({
      publicationNumber: "FICTIONAL-PUB-0001",
      applicationNumber: "FICTIONAL-APP-0001",
      registrationDate: null,
      displayFlagCount: { sourceValue: "1", value: 1 },
      displayFlags: ["請"],
      firstApplicantLocation: { sourceValue: "", value: null },
      firstPartyIdentifier: { sourceValue: "00001", value: "00001" },
      firstApplicantName: { sourceValue: "", value: null },
      projectionCompleteness: "lossy_first_values_only",
      matchesCandidate: true,
    });
  });

  it("JPB 18列はrecordLength一致でも常にunverified reviewにする", () => {
    const result = parse("JPB", [parsedRecord(jpbCells())]);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("jpb_record_length_unverified");
    expect(result.records[0].projection).toMatchObject({
      registrationDate: "20990228",
      displayFlags: ["早", "際"],
      matchesCandidate: true,
    });
  });

  it("JPB recordLength不一致もfailedへ昇格せず候補比較を保持する", () => {
    const result = parse("JPB", [
      withWrongRecordLength(parsedRecord(jpbCells())),
    ]);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toEqual(["jpb_record_length_unverified"]);
    expect(result.records[0].projection?.matchesCandidate).toBe(false);
  });

  it("JPA recordLength不一致をfailedにする", () => {
    const result = parse("JPA", [
      withWrongRecordLength(parsedRecord(jpaCells())),
    ]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("character_length_mismatch");
    expect(result.records[0].projection).toBeNull();
  });

  it.each(["missing", "extra"] as const)(
    "%s columnをfailedにして捨てない",
    (kind) => {
      const cells = jpaCells();
      if (kind === "missing") cells.pop();
      else cells.push("FICTIONAL-EXTRA-CELL");

      const result = parse("JPA", [parsedRecord(cells)]);

      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toContain("column_count_mismatch");
      expect(result.records[0].sourceCells).toHaveLength(
        kind === "missing" ? 16 : 18,
      );
    },
  );

  it.each([
    ["active-empty", "1", "", " "],
    ["active-space", "1", " ", " "],
    ["unused-empty", "1", "請", ""],
    ["unused-tab", "1", "請", "\t"],
    ["unused-multiple-space", "1", "請", "  "],
    ["unused-fullwidth-space", "1", "請", "　"],
  ] as const)("%s slot違反をfailedにする", (_label, count, first, second) => {
    const cells = jpaCells();
    cells[4] = count;
    cells[5] = first;
    cells[6] = second;

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("display_slot_mismatch");
  });

  it("displayFlagCountが7を超える場合をfailedにする", () => {
    const cells = jpaCells();
    cells[4] = "8";

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("display_slot_mismatch");
  });

  it.each([0, 7])("displayFlagCount=%iのslot契約を受理する", (count) => {
    const cells = jpaCells();
    cells[4] = String(count);
    for (let index = 0; index < 7; index += 1) {
      cells[5 + index] = index < count ? "請" : " ";
    }

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("success");
    expect(result.records[0].projection?.displayFlags).toHaveLength(count);
  });

  it("JPB invalid recordLengthをfailedにしつつunverified reviewも保持する", () => {
    const record = parsedRecord(jpbCells());
    const sourceCells = [...record.sourceCells];
    sourceCells[0] = "not-a-decimal";
    const invalidRecord = {
      ...record,
      sourceCells,
      rawRecord: rawRecord(sourceCells),
    };

    const result = parse("JPB", [invalidRecord]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "invalid_decimal",
        "jpb_record_length_unverified",
      ]),
    );
  });

  it("unknown active display flagをsource保持してreviewにする", () => {
    const cells = jpaCells();
    cells[5] = "FICTIONAL-UNKNOWN-FLAG";

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unknown_display_flag");
    expect(result.records[0].projection?.displaySlot1).toBe(
      "FICTIONAL-UNKNOWN-FLAG",
    );
  });

  it("required fieldとJPB dateを検証し、空titleだけはreviewにする", () => {
    const requiredCells = jpaCells();
    requiredCells[2] = "";
    const requiredResult = parse("JPA", [parsedRecord(requiredCells)]);
    expect(requiredResult.status).toBe("failed");
    expect(issueCodes(requiredResult)).toContain("required_field_empty");

    const dateCells = jpbCells();
    dateCells[3] = "20990230";
    const dateResult = parse("JPB", [parsedRecord(dateCells)]);
    expect(dateResult.status).toBe("failed");
    expect(issueCodes(dateResult)).toContain("invalid_date");

    const titleCells = jpaCells();
    titleCells[13] = "";
    const titleResult = parse("JPA", [parsedRecord(titleCells)]);
    expect(titleResult.status).toBe("review_required");
    expect(issueCodes(titleResult)).toContain("empty_title");
    expect(titleResult.records[0].projection).not.toBeNull();
  });

  it("同一publication numberの全recordをreviewにして統合しない", () => {
    const records = [
      parsedRecord(jpaCells("FICTIONAL-DUPLICATE-PUB"), 1),
      parsedRecord(jpaCells("FICTIONAL-DUPLICATE-PUB"), 2),
    ];

    const result = parse("JPA", records);

    expect(result.status).toBe("review_required");
    expect(result.records).toHaveLength(2);
    expect(
      result.records.every((record) =>
        record.issues.some(
          (issue) => issue.code === "duplicate_publication_number",
        ),
      ),
    ).toBe(true);
  });

  it("0 recordをfile-level required_record_missingにする", () => {
    const result = parse("JPA", []);

    expect(result.status).toBe("failed");
    expect(result.records).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "required_record_missing",
    ]);
  });
});
