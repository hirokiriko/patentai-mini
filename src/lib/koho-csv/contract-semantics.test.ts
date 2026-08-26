import { describe, expect, it } from "vitest";

import {
  parseKohoCsv,
  type KohoCsvContractLimits,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
} from "./index";

const LIMITS: KohoCsvContractLimits = {
  maxInputBytes: 1_000_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 100_000,
};

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function encodeCell(value: string): string {
  return /[",\r\n]/.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function rawRecord(cells: readonly string[]): string {
  return cells.map(encodeCell).join(",");
}

function csv(records: readonly (readonly string[])[]): string {
  return `${records.map(rawRecord).join("\r\n")}\r\n`;
}

function withStableRecordLength(cells: readonly string[]): string[] {
  const stable = [...cells];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const next = String(codePointLength(rawRecord(stable)) + 1);
    if (stable[0] === next) return stable;
    stable[0] = next;
  }
  throw new Error("fictional record length did not stabilize");
}

function parse(
  input: Omit<KohoCsvContractParseInput, "limits"> & {
    limits?: KohoCsvContractLimits;
  },
): KohoCsvContractParseResult {
  return parseKohoCsv({ ...input, limits: input.limits ?? LIMITS });
}

function issueCodes(result: KohoCsvContractParseResult): string[] {
  return [
    ...result.issues.map((item) => item.code),
    ...result.records.flatMap((record) => record.issues.map((item) => item.code)),
  ];
}

const JPA_SECTIONS = [
  ["公開特許公報（特開）", "P_A1"],
  ["補正の掲載（公開特許公報）", "P_A5"],
  ["公表特許公報（特表）", "P_P1"],
  ["国際公開後における補正の掲載", "P_P5"],
] as const;

function jpaAbstractCsv(): string {
  return csv([
    ["JPA", "20990228", "FICTIONAL-ISSUE-0001", "01122"],
    ...JPA_SECTIONS.map(([sectionName], index) => [
      sectionName,
      index === 0
        ? "  FICTIONAL::OPAQUE  "
        : `FICTIONAL-OPAQUE-${index + 1}`,
      index === 0 ? "00099" : "00001",
    ]),
  ]);
}

function jpbAbstractCsv(): string {
  return csv([
    ["JPB", "20990228", "FICTIONAL-ISSUE-B-0001", "01122"],
    [
      "特許公報",
      "FICTIONAL::OPAQUE::JPB",
      "00001",
      "0002;0002",
      "0999",
    ],
  ]);
}

interface FictionalApplicant {
  location: string;
  partyIdentifier: string;
  applicantName: string;
}

interface Contents1Options {
  publicationNumber?: string;
  displayFlags?: string[];
  classifications?: string[];
  title?: string;
  applicants?: FictionalApplicant[];
}

function contents1Cells(
  packageType: "JPA" | "JPB",
  options: Contents1Options = {},
): string[] {
  const displayFlags =
    options.displayFlags ?? (packageType === "JPA" ? ["請"] : ["早", "際"]);
  const classifications = options.classifications ?? ["FICTIONAL-CLASS-1"];
  const title = options.title ?? "架空発明😀";
  const applicants = options.applicants ?? [
    {
      location: "架空所在地😀",
      partyIdentifier: "00001",
      applicantName: "架空出願人😀",
    },
  ];
  const applicantCells = applicants.flatMap((applicant) => [
    String(codePointLength(applicant.location)),
    applicant.location,
    applicant.partyIdentifier,
    String(codePointLength(applicant.applicantName)),
    applicant.applicantName,
  ]);

  return withStableRecordLength([
    "0",
    packageType === "JPA" ? "P_A1" : "P_B1",
    options.publicationNumber ??
      (packageType === "JPA"
        ? "FICTIONAL-PUB-A-0001"
        : "FICTIONAL-PUB-B-0001"),
    ...(packageType === "JPB" ? ["20990228"] : []),
    packageType === "JPA"
      ? "FICTIONAL-APP-A-0001"
      : "FICTIONAL-APP-B-0001",
    String(displayFlags.length),
    ...displayFlags,
    String(classifications.length),
    ...classifications,
    String(codePointLength(title)),
    title,
    String(applicants.length),
    ...applicantCells,
  ]);
}

interface Contents2Options {
  publicationNumber?: string;
  displayFlagCount?: number;
  slots?: string[];
  forceRecordLengthMismatch?: boolean;
}

function contents2Cells(
  packageType: "JPA" | "JPB",
  options: Contents2Options = {},
): string[] {
  const slots = options.slots ??
    (packageType === "JPA"
      ? ["請", " ", " ", " ", " ", " ", " "]
      : ["早", "際", " ", " ", " ", " ", " "]);
  if (slots.length !== 7) {
    throw new Error("fictional CONTENTS2 fixture requires seven display slots");
  }
  const displayFlagCount =
    options.displayFlagCount ?? (packageType === "JPA" ? 1 : 2);
  const stable = withStableRecordLength([
    "0",
    packageType === "JPA" ? "P_A1" : "P_B1",
    options.publicationNumber ??
      (packageType === "JPA"
        ? "FICTIONAL-PUB-A-0001"
        : "FICTIONAL-PUB-B-0001"),
    ...(packageType === "JPB" ? ["20990228"] : []),
    packageType === "JPA"
      ? "FICTIONAL-APP-A-0001"
      : "FICTIONAL-APP-B-0001",
    String(displayFlagCount),
    ...slots,
    "FICTIONAL-CLASS-1",
    "架空発明",
    "架空所在地",
    "00001",
    "架空出願人",
  ]);
  if (options.forceRecordLengthMismatch) stable[0] = "1";
  return stable;
}

describe("Issue #40 prefixed contract semantics", () => {
  describe("ABSTRACT.csv", () => {
    it("JPAのexact 4 sectionとrangeのopaque sourceをそのまま保持する", () => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "abstract",
        entryPath: "ABSTRACT.csv",
        csv: jpaAbstractCsv(),
      });

      expect(result.status).toBe("success");
      expect(result.records[0].semantic).toEqual(
        expect.objectContaining({ issueControlValue: "01122" }),
      );
      expect(issueCodes(result)).not.toContain("opaque_control_value");
      expect(result.records.slice(1).map((record) => record.semantic)).toEqual(
        JPA_SECTIONS.map(([sectionName, section], index) =>
          expect.objectContaining({
            sectionName,
            normalizedSectionName: sectionName,
            section,
            publicationNumberRange:
              index === 0
                ? "  FICTIONAL::OPAQUE  "
                : `FICTIONAL-OPAQUE-${index + 1}`,
          }),
        ),
      );
    });

    it("JPBの欠番・範囲外listを数値化せずsource順とduplicateごと保持する", () => {
      const result = parse({
        packageType: "JPB",
        logicalFile: "abstract",
        entryPath: "ABSTRACT.csv",
        csv: jpbAbstractCsv(),
      });

      expect(result.status).toBe("success");
      expect(result.records[1].semantic).toEqual(
        expect.objectContaining({
          section: "P_B1",
          publicationNumberRange: "FICTIONAL::OPAQUE::JPB",
          missingNumbersInRange: {
            sourceValue: "0002;0002",
            values: ["0002", "0002"],
          },
          includedNumbersOutsideRange: {
            sourceValue: "0999",
            values: ["0999"],
          },
        }),
      );
    });

    it("空のissueControlValueもopaque sourceとして保持する", () => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "abstract",
        entryPath: "ABSTRACT.csv",
        csv: csv([
          ["JPA", "20990228", "FICTIONAL-ISSUE-0001", ""],
          ["公開特許公報（特開）", "FICTIONAL-RANGE", "00001"],
        ]),
      });

      expect(result.status).toBe("success");
      expect(result.records[0].sourceCells[3]).toBe("");
      expect(result.records[0].semantic).toEqual(
        expect.objectContaining({ issueControlValue: "" }),
      );
      expect(issueCodes(result)).not.toContain("required_value_missing");
    });

    it.each([
      [
        "公開特許公報（特開）  ",
        "公開特許公報（特開）  ",
        "公開特許公報（特開）",
        "success",
      ],
      [
        " 公開特許公報（特開）",
        " 公開特許公報（特開）",
        " 公開特許公報（特開）",
        "review_required",
      ],
      [
        "公開特許公報（特開）\t",
        "公開特許公報（特開）\t",
        "公開特許公報（特開）\t",
        "review_required",
      ],
      [
        "公開特許公報（特開）　",
        "公開特許公報（特開）　",
        "公開特許公報（特開）　",
        "review_required",
      ],
    ] as const)(
      "section照合は末尾ASCII spaceだけを除去する: %s",
      (sectionName, sourceValue, normalizedValue, expectedStatus) => {
        const result = parse({
          packageType: "JPA",
          logicalFile: "abstract",
          entryPath: "ABSTRACT.csv",
          csv: csv([
            ["JPA", "20990228", "FICTIONAL-ISSUE-0001", "01122"],
            [sectionName, "FICTIONAL-RANGE", "00001"],
          ]),
        });

        expect(result.status).toBe(expectedStatus);
        expect(result.records[1].sourceCells[0]).toBe(sourceValue);
        expect(result.records[1].semantic).toEqual(
          expect.objectContaining({
            sectionName: sourceValue,
            normalizedSectionName: normalizedValue,
          }),
        );
        if (expectedStatus === "review_required") {
          expect(issueCodes(result)).toContain("unknown_section");
        } else {
          expect(issueCodes(result)).not.toContain("unknown_section");
        }
      },
    );
  });

  describe("DOCUMENT_LIST.csv", () => {
    it.each([
      ["JPA", ["A", "A5"]],
      ["JPB", ["B1", "B2"]],
    ] as const)("%sのknown kindとleading zeroを保持する", (packageType, kinds) => {
      const records = kinds.map((kind, index) => [
        "JP",
        `000000${index + 1}`,
        kind,
        index === 0 ? "20990228" : "20990301",
      ]);
      const result = parse({
        packageType,
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv: csv(records),
      });

      expect(result.status).toBe("success");
      if (result.logicalFile !== "document_list") {
        throw new Error("expected DOCUMENT_LIST contract result");
      }
      expect(
        result.records.map((record) => record.semantic?.kindCode.sourceValue),
      ).toEqual([...kinds]);
      expect(result.records[0].semantic?.publicationNumber).toBe("0000001");
    });

    it("countryとcross-package・unknown kindをreviewにしてsourceを保持する", () => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv: csv([
          ["jp", "0000001", "B1", "20990228"],
          ["JP", "0000002", "FICTIONAL-KIND", "20990301"],
        ]),
      });

      expect(result.status).toBe("review_required");
      expect(issueCodes(result)).toEqual(
        expect.arrayContaining(["unknown_country_code", "unknown_kind_code"]),
      );
      if (result.logicalFile !== "document_list") {
        throw new Error("expected DOCUMENT_LIST contract result");
      }
      expect(result.records[0].semantic).toEqual(
        expect.objectContaining({
          countryCode: { sourceValue: "jp", knownValue: null },
          kindCode: { sourceValue: "B1", knownValue: "B1" },
        }),
      );
      expect(result.records[1].semantic?.kindCode).toEqual({
        sourceValue: "FICTIONAL-KIND",
        knownValue: null,
      });
    });

    it("duplicateとkind/date conflictを全該当recordへroll-upする", () => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        csv: csv([
          ["JP", "0000001", "A", "20990228"],
          ["JP", "0000001", "A", "20990228"],
          ["JP", "0000001", "A5", "20990301"],
        ]),
      });
      const codes = issueCodes(result);

      expect(result.status).toBe("review_required");
      expect(codes.filter((code) => code === "duplicate_publication_number")).toHaveLength(3);
      expect(codes.filter((code) => code === "conflicting_duplicate")).toHaveLength(3);
      expect(result.recordCount).toBe(3);
    });
  });

  describe("CONTENTS1.csv", () => {
    it("複数countとsupplementary characterのUnicode長をsource順でparseする", () => {
      const cells = contents1Cells("JPA", {
        displayFlags: ["請", "請"],
        classifications: ["FICTIONAL-CLASS-1", "FICTIONAL-CLASS-2"],
        title: "架空😀",
        applicants: [
          {
            location: "東京😀",
            partyIdentifier: "00001",
            applicantName: "架空者😀",
          },
          {
            location: "大阪",
            partyIdentifier: "00002",
            applicantName: "架空二号",
          },
        ],
      });
      const result = parse({
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_A1/CONTENTS1.csv",
        csv: csv([cells]),
      });

      expect(result.status).toBe("success");
      if (result.logicalFile !== "contents1") {
        throw new Error("expected CONTENTS1 contract result");
      }
      expect(result.records[0].semantic).toEqual(
        expect.objectContaining({
          displayFlags: ["請", "請"],
          displayClassifications: [
            "FICTIONAL-CLASS-1",
            "FICTIONAL-CLASS-2",
          ],
          titleCharacterLength: { sourceValue: "3", value: 3 },
          title: "架空😀",
          applicantCount: { sourceValue: "2", value: 2 },
          applicants: [
            expect.objectContaining({
              locationCharacterLength: { sourceValue: "3", value: 3 },
              partyIdentifier: { sourceValue: "00001", value: "00001" },
              applicantNameCharacterLength: { sourceValue: "4", value: 4 },
            }),
            expect.objectContaining({
              partyIdentifier: { sourceValue: "00002", value: "00002" },
            }),
          ],
        }),
      );
    });

    it("count=0では反復cellを省略し、未知flagだけはsource保持してreviewにする", () => {
      const zero = parse({
        packageType: "JPB",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_B1/CONTENTS1.csv",
        csv: csv([
          contents1Cells("JPB", {
            displayFlags: [],
            classifications: [],
            applicants: [],
          }),
        ]),
      });
      expect(zero.status).toBe("success");
      if (zero.logicalFile !== "contents1") {
        throw new Error("expected CONTENTS1 contract result");
      }
      expect(zero.records[0].semantic).toEqual(
        expect.objectContaining({
          displayFlags: [],
          displayClassifications: [],
          applicants: [],
        }),
      );

      const unknown = parse({
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_P1/CONTENTS1.csv",
        csv: csv([
          contents1Cells("JPA", {
            displayFlags: ["FICTIONAL-FLAG"],
          }),
        ]),
      });
      expect(unknown.status).toBe("review_required");
      expect(issueCodes(unknown)).toContain("unknown_display_flag");
      if (unknown.logicalFile !== "contents1") {
        throw new Error("expected CONTENTS1 contract result");
      }
      expect(unknown.records[0].semantic?.displayFlags).toEqual([
        "FICTIONAL-FLAG",
      ]);
    });
  });

  describe("CONTENTS2.csv", () => {
    it("JPA 17列の7 active slotをsourceとsemantic viewの両方へ保持する", () => {
      const slots = Array(7).fill("請");
      const result = parse({
        packageType: "JPA",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_A1/CONTENTS2.csv",
        csv: csv([
          contents2Cells("JPA", { displayFlagCount: 7, slots }),
        ]),
      });

      expect(result.status).toBe("success");
      expect(result.records[0].sourceCells).toHaveLength(17);
      expect(result.records[0].sourceCells.slice(5, 12)).toEqual(slots);
      if (result.logicalFile !== "contents2") {
        throw new Error("expected CONTENTS2 contract result");
      }
      expect(result.records[0].semantic?.semanticDisplaySlots).toEqual(slots);
    });

    it("JPB 18列の未使用single-spaceをnull viewへ変換し、長さ一致時はsuccessにする", () => {
      const result = parse({
        packageType: "JPB",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_B1/CONTENTS2.csv",
        csv: csv([contents2Cells("JPB")]),
      });

      expect(result.status).toBe("success");
      expect(result.records[0].sourceCells).toHaveLength(18);
      expect(result.records[0].sourceCells.slice(6, 13)).toEqual([
        "早",
        "際",
        " ",
        " ",
        " ",
        " ",
        " ",
      ]);
      if (result.logicalFile !== "contents2") {
        throw new Error("expected CONTENTS2 contract result");
      }
      expect(result.records[0].semantic?.semanticDisplaySlots).toEqual([
        "早",
        "際",
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(issueCodes(result)).not.toContain("record_length_mismatch");
    });

    it.each([
      ["JPA", "DOCUMENT/P_P1/CONTENTS2.csv", "failed"],
      ["JPB", "DOCUMENT/P_B1/CONTENTS2.csv", "review_required"],
    ] as const)(
      "%sのrecord length mismatchを契約どおりroll-upする",
      (packageType, entryPath, expectedStatus) => {
        const result = parse({
          packageType,
          logicalFile: "contents2",
          entryPath,
          csv: csv([
            contents2Cells(packageType, {
              forceRecordLengthMismatch: true,
            }),
          ]),
        });
        const mismatch = result.records[0].issues.find(
          (item) => item.code === "record_length_mismatch",
        );

        expect(result.status).toBe(expectedStatus);
        expect(mismatch?.status).toBe(expectedStatus);
      },
    );

    it("unused slotのempty stringをsingle-spaceと同一視しない", () => {
      const result = parse({
        packageType: "JPA",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_A1/CONTENTS2.csv",
        csv: csv([
          contents2Cells("JPA", {
            displayFlagCount: 0,
            slots: ["", " ", " ", " ", " ", " ", " "],
          }),
        ]),
      });

      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toContain("display_slot_mismatch");
      expect(result.records[0].sourceCells[5]).toBe("");
    });
  });
});

describe("Issue #40 exact path contract", () => {
  it("root、JPA A1/P1、JPB B1のexact配置だけを通常配置として扱う", () => {
    const cases = [
      {
        packageType: "JPA",
        logicalFile: "abstract",
        entryPath: "ABSTRACT.csv",
        normalizedEntryPath: "ABSTRACT.csv",
        csv: jpaAbstractCsv(),
      },
      {
        packageType: "JPA",
        logicalFile: "document_list",
        entryPath: "DOCUMENT_LIST.csv",
        normalizedEntryPath: "DOCUMENT_LIST.csv",
        csv: csv([["JP", "0000001", "A", "20990228"]]),
      },
      ...(["P_A1", "P_P1"] as const).flatMap((section) => [
        {
          packageType: "JPA" as const,
          logicalFile: "contents1" as const,
          entryPath: `DOCUMENT/${section}/CONTENTS1.csv`,
          normalizedEntryPath: `DOCUMENT/${section}/CONTENTS1.csv`,
          csv: csv([contents1Cells("JPA")]),
        },
        {
          packageType: "JPA" as const,
          logicalFile: "contents2" as const,
          entryPath: `DOCUMENT/${section}/CONTENTS2.csv`,
          normalizedEntryPath: `DOCUMENT/${section}/CONTENTS2.csv`,
          csv: csv([contents2Cells("JPA")]),
        },
      ]),
      {
        packageType: "JPB",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_B1/CONTENTS1.csv",
        normalizedEntryPath: "DOCUMENT/P_B1/CONTENTS1.csv",
        csv: csv([contents1Cells("JPB")]),
      },
      {
        packageType: "JPB",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_B1/CONTENTS2.csv",
        normalizedEntryPath: "DOCUMENT/P_B1/CONTENTS2.csv",
        csv: csv([contents2Cells("JPB")]),
      },
      {
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "DOCUMENT\\P_A1\\CONTENTS1.csv",
        normalizedEntryPath: "DOCUMENT/P_A1/CONTENTS1.csv",
        csv: csv([contents1Cells("JPA")]),
      },
    ] as const;

    for (const item of cases) {
      const result = parse({
        packageType: item.packageType,
        logicalFile: item.logicalFile,
        entryPath: item.entryPath,
        csv: item.csv,
      });
      expect(result.status, item.entryPath).toBe("success");
      expect(result.normalizedEntryPath).toBe(item.normalizedEntryPath);
      expect(issueCodes(result)).not.toContain("unexpected_file_location");
    }
  });

  it("A5/P5、cross-package、P_B2、extra segment、root外をreview後もparseする", () => {
    const cases = [
      {
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_A5/CONTENTS1.csv",
        csv: csv([contents1Cells("JPA")]),
      },
      {
        packageType: "JPA",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_P5/CONTENTS2.csv",
        csv: csv([contents2Cells("JPA")]),
      },
      {
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_B1/CONTENTS1.csv",
        csv: csv([contents1Cells("JPA")]),
      },
      {
        packageType: "JPB",
        logicalFile: "contents2",
        entryPath: "DOCUMENT/P_A1/CONTENTS2.csv",
        csv: csv([contents2Cells("JPB")]),
      },
      {
        packageType: "JPB",
        logicalFile: "contents1",
        entryPath: "DOCUMENT/P_B2/CONTENTS1.csv",
        csv: csv([contents1Cells("JPB")]),
      },
      {
        packageType: "JPA",
        logicalFile: "contents1",
        entryPath: "EXTRA/DOCUMENT/P_A1/CONTENTS1.csv",
        csv: csv([contents1Cells("JPA")]),
      },
      {
        packageType: "JPA",
        logicalFile: "abstract",
        entryPath: "FOLDER/ABSTRACT.csv",
        csv: jpaAbstractCsv(),
      },
      {
        packageType: "JPA",
        logicalFile: "abstract",
        entryPath: "FOLDER/%2E%2E/ABSTRACT.csv",
        csv: jpaAbstractCsv(),
      },
    ] as const;

    for (const item of cases) {
      const result = parse({
        packageType: item.packageType,
        logicalFile: item.logicalFile,
        entryPath: item.entryPath,
        csv: item.csv,
      });
      expect(result.status, item.entryPath).toBe("review_required");
      expect(issueCodes(result)).toContain("unexpected_file_location");
      expect(result.recordCount).toBeGreaterThan(0);
      expect(result.normalizedEntryPath).toBe(item.entryPath.replaceAll("\\", "/"));
    }
  });
});
