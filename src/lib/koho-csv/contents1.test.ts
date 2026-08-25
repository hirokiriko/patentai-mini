import { describe, expect, it } from "vitest";

import { parseKohoCsv } from "./index";
import { parseContents1Records } from "./parse-contents1";
import { fictionalCsvBytes } from "./__fixtures__/fictional-csv";
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
  throw new Error("fictional CONTENTS1 record length did not stabilize");
}

function parsedRecord(
  cells: readonly string[],
  ordinal = 1,
): ParsedCsvRecord {
  const stableCells = withStableRecordLength(cells);
  const raw = rawRecord(stableCells);
  const embeddedNewlines = raw.match(/\r\n|\r|\n/g)?.length ?? 0;
  return {
    ordinal,
    startLine: ordinal,
    endLine: ordinal + embeddedNewlines,
    rawRecord: raw,
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

function jpaCells(overrides: Partial<{
  publicationNumber: string;
  applicationNumber: string;
  displayFlags: string[];
  classifications: string[];
  title: string;
  location: string;
  partyIdentifier: string;
  applicantName: string;
}> = {}): string[] {
  const displayFlags = overrides.displayFlags ?? ["請"];
  const classifications = overrides.classifications ?? ["FICTIONAL-CLASS-1"];
  const title = overrides.title ?? "架空発明😀";
  const location = overrides.location ?? "架空所在地";
  const applicantName = overrides.applicantName ?? "架空出願人";
  return [
    "0",
    "P_A1",
    overrides.publicationNumber ?? "FICTIONAL-PUB-0001",
    overrides.applicationNumber ?? "FICTIONAL-APP-0001",
    String(displayFlags.length),
    ...displayFlags,
    String(classifications.length),
    ...classifications,
    String(codePointLength(title)),
    title,
    "1",
    String(codePointLength(location)),
    location,
    overrides.partyIdentifier ?? "00001",
    String(codePointLength(applicantName)),
    applicantName,
  ];
}

function jpbCells(): string[] {
  const title = "架空登録発明";
  return [
    "0",
    "P_B1",
    "FICTIONAL-PUB-B-0001",
    "20990228",
    "FICTIONAL-APP-B-0001",
    "2",
    "早",
    "際",
    "0",
    String(codePointLength(title)),
    title,
    "0",
  ];
}

function parse(
  packageType: KohoCsvPackageType,
  records: ParsedCsvRecord[],
  limits: KohoCsvLimits = DEFAULT_LIMITS,
) {
  return parseContents1Records({ packageType, records, limits });
}

function parsePublic(
  packageType: KohoCsvPackageType,
  entryPath: string,
  record: ParsedCsvRecord,
) {
  const result = parseKohoCsv({
    packageType,
    entryPath,
    bytes: fictionalCsvBytes(`${record.rawRecord}\r\n`),
    limits: DEFAULT_LIMITS,
  });
  if (result.logicalFile !== "CONTENTS1") {
    throw new Error("expected a CONTENTS1 result");
  }
  return result;
}

function issueCodes(result: ReturnType<typeof parseContents1Records>) {
  return result.records.flatMap((record) =>
    record.issues.map((issue) => issue.code),
  );
}

describe("parseContents1Records", () => {
  it("JPAの反復fieldとUnicode code point長をsource表現付きでparseする", () => {
    const title = "架空,発明😀\r\n第二行";
    const location = "架空,所在地";
    const applicantName = '架空"出願人';
    const record = parsedRecord(
      jpaCells({
        displayFlags: ["請"],
        classifications: ["FICTIONAL-CLASS-1", "FICTIONAL-CLASS-2"],
        title,
        location,
        partyIdentifier: "00007",
        applicantName,
      }),
    );

    const result = parsePublic(
      "JPA",
      "DOCUMENT/P_A1/CONTENTS1.csv",
      record,
    );

    expect(result.status).toBe("success");
    expect(result.issues).toEqual([]);
    expect(result.recordCount).toBe(1);
    expect(result.encoding.bom).toBe("none");
    expect(result.lineEndings).toEqual({
      style: "crlf",
      crlfCount: 2,
      lfCount: 0,
      crCount: 0,
      hasTerminalCrlf: true,
    });
    expect(result.records[0].rawRecord).toBe(record.rawRecord);
    expect(result.records[0].sourceCells).toEqual(record.sourceCells);
    expect(result.records[0].projection).toMatchObject({
      registrationDate: null,
      displayFlags: ["請"],
      displayClassifications: [
        "FICTIONAL-CLASS-1",
        "FICTIONAL-CLASS-2",
      ],
      title,
      applicants: [
        {
          location,
          partyIdentifier: { sourceValue: "00007", value: "00007" },
          applicantName,
        },
      ],
    });
    expect(result.records[0].projection?.titleCharacterLength.value).toBe(
      codePointLength(title),
    );
    expect(result.records[0].projection?.recordCharacterLength.value).toBe(
      codePointLength(record.rawRecord) + 1,
    );
  });

  it("JPBのregistrationDate、複数flag、count=0をparseする", () => {
    const record = parsedRecord(jpbCells());
    const result = parsePublic(
      "JPB",
      "DOCUMENT/P_B1/CONTENTS1.csv",
      record,
    );

    expect(result.status).toBe("success");
    expect(result.recordCount).toBe(1);
    expect(result.records[0].rawRecord).toBe(record.rawRecord);
    expect(result.records[0].projection).toMatchObject({
      registrationDate: "20990228",
      displayFlagCount: { sourceValue: "2", value: 2 },
      displayFlags: ["早", "際"],
      displayClassificationCount: { sourceValue: "0", value: 0 },
      displayClassifications: [],
      applicantCount: { sourceValue: "0", value: 0 },
      applicants: [],
    });
  });

  it("JPA P_P1 pathを公開APIからCONTENTS1へdispatchする", () => {
    const record = parsedRecord(
      jpaCells({ publicationNumber: "FICTIONAL-PUB-P1-0001" }),
    );
    const result = parsePublic(
      "JPA",
      "DOCUMENT/P_P1/CONTENTS1.csv",
      record,
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "success",
        logicalFile: "CONTENTS1",
        normalizedEntryPath: "DOCUMENT/P_P1/CONTENTS1.csv",
        recordCount: 1,
      }),
    );
    expect(result.records[0].sourceCells).toEqual(record.sourceCells);
  });

  it("unknown flagと空title・applicant nameをsource保持してreviewにする", () => {
    const result = parse("JPA", [
      parsedRecord(
        jpaCells({
          displayFlags: ["FICTIONAL-UNKNOWN-FLAG"],
          title: "",
          applicantName: "",
        }),
      ),
    ]);

    expect(result.status).toBe("review_required");
    expect(result.records[0].projection).not.toBeNull();
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "unknown_display_flag",
        "empty_title",
        "empty_applicant_name",
      ]),
    );
  });

  it("不正なJPB registrationDateをfailedにする", () => {
    const cells = jpbCells();
    cells[3] = "20990230";

    const result = parse("JPB", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("invalid_date");
    expect(result.records[0].projection).toBeNull();
  });

  it.each([
    ["divisionSectionCode", 1],
    ["formattedPublicationNumber", 2],
    ["formattedApplicationNumber", 3],
  ] as const)("空%sをrequired failureにする", (field, index) => {
    const cells = jpaCells();
    cells[index] = "";

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(result.records[0].issues).toContainEqual(
      expect.objectContaining({ code: "required_field_empty", field }),
    );
  });

  it.each([
    ["displayFlags[0]", 5],
    ["displayClassifications[0]", 7],
  ] as const)("空%sをrequired failureにする", (field, index) => {
    const cells = jpaCells();
    cells[index] = "";

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(result.records[0].issues).toContainEqual(
      expect.objectContaining({ code: "required_field_empty", field }),
    );
  });

  it("空locationとpartyIdentifierをsource表現付きで許可する", () => {
    const result = parse("JPA", [
      parsedRecord(jpaCells({ location: "", partyIdentifier: "" })),
    ]);

    expect(result.status).toBe("success");
    expect(result.records[0].projection?.applicants[0]).toEqual(
      expect.objectContaining({
        location: "",
        partyIdentifier: { sourceValue: "", value: null },
      }),
    );
  });

  it.each([
    ["displayFlagCount", 4],
    ["displayClassificationCount", 6],
    ["applicantCount", 10],
  ] as const)("%sの上限を超えた時点でfailedにする", (_field, index) => {
    const cells = jpaCells();
    cells[index] = "3";
    const result = parse("JPA", [parsedRecord(cells)], {
      ...DEFAULT_LIMITS,
      maxRepeatedItemsPerRecord: 2,
    });

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("repeated_item_limit_exceeded");
    expect(result.records[0].projection).toBeNull();
  });

  it.each(["-1", "1.5", "9007199254740992"])(
    "不正なcount %sをinvalid_decimalへ分類する",
    (sourceValue) => {
      const cells = jpaCells();
      cells[4] = sourceValue;

      const result = parse("JPA", [parsedRecord(cells)]);

      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toContain("invalid_decimal");
      expect(result.records[0].projection).toBeNull();
    },
  );

  it("3つのcount=0では反復cellを省略する", () => {
    const title = "架空反復なし発明";
    const cells = [
      "0",
      "P_A1",
      "FICTIONAL-PUB-ZERO",
      "FICTIONAL-APP-ZERO",
      "0",
      "0",
      String(codePointLength(title)),
      title,
      "0",
    ];

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("success");
    expect(result.records[0].projection).toMatchObject({
      displayFlags: [],
      displayClassifications: [],
      applicants: [],
    });
  });

  it("複数applicantをsource順で保持する", () => {
    const cells = jpaCells();
    const secondLocation = "架空第二所在地";
    const secondName = "架空第二出願人";
    cells[10] = "2";
    cells.push(
      String(codePointLength(secondLocation)),
      secondLocation,
      "00002",
      String(codePointLength(secondName)),
      secondName,
    );

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("success");
    expect(result.records[0].projection?.applicants).toHaveLength(2);
    expect(
      result.records[0].projection?.applicants.map(
        (applicant) => applicant.partyIdentifier.sourceValue,
      ),
    ).toEqual(["00001", "00002"]);
  });

  it("applicant長decimal不正をcell count mismatchと混同しない", () => {
    const cells = jpaCells();
    cells[11] = "1.5";

    const result = parse("JPA", [parsedRecord(cells)]);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("invalid_decimal");
    expect(issueCodes(result)).not.toContain("repeated_cell_count_mismatch");
  });

  it.each(["missing", "extra"] as const)(
    "%s repeated cellをfailedにする",
    (kind) => {
      const cells = jpaCells();
      if (kind === "missing") cells.pop();
      else cells.push("FICTIONAL-EXTRA-CELL");

      const result = parse("JPA", [parsedRecord(cells)]);

      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toContain("repeated_cell_count_mismatch");
      expect(result.records[0].projection).toBeNull();
    },
  );

  it("title・location・nameの文字長不一致をすべて保持してfailedにする", () => {
    const cells = jpaCells();
    const titleLengthIndex = 8;
    const locationLengthIndex = 11;
    const nameLengthIndex = 14;
    cells[titleLengthIndex] = "999";
    cells[locationLengthIndex] = "999";
    cells[nameLengthIndex] = "999";

    const result = parse("JPA", [parsedRecord(cells)]);
    const mismatches = result.records[0].issues.filter(
      (issue) => issue.code === "character_length_mismatch",
    );

    expect(result.status).toBe("failed");
    expect(mismatches.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        "titleCharacterLength",
        "applicants[0].locationCharacterLength",
        "applicants[0].applicantNameCharacterLength",
      ]),
    );
  });

  it("recordCharacterLength不一致をfailedにする", () => {
    const result = parse("JPA", [
      withWrongRecordLength(parsedRecord(jpaCells())),
    ]);

    expect(result.status).toBe("failed");
    expect(
      result.records[0].issues.some(
        (issue) =>
          issue.code === "character_length_mismatch" &&
          issue.field === "recordCharacterLength",
      ),
    ).toBe(true);
  });

  it("同一publication numberの全recordをreviewにして統合しない", () => {
    const records = [
      parsedRecord(jpaCells({ applicationNumber: "FICTIONAL-APP-1" }), 1),
      parsedRecord(jpaCells({ applicationNumber: "FICTIONAL-APP-2" }), 2),
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
