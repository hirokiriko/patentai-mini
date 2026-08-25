import { describe, expect, it } from "vitest";

import { parseKohoCsv } from "./index";
import {
  FICTIONAL_LIMITS,
  fictionalAbstractCsv,
  fictionalCsvBytes,
} from "./__fixtures__/fictional-csv";

function parseAbstract(packageType: "JPA" | "JPB", csv: string) {
  const result = parseKohoCsv({
    packageType,
    entryPath: "ABSTRACT.csv",
    bytes: fictionalCsvBytes(csv),
    limits: FICTIONAL_LIMITS,
  });
  if (result.logicalFile !== "ABSTRACT") {
    throw new Error("expected an ABSTRACT result");
  }
  return result;
}

describe("parseKohoCsv ABSTRACT", () => {
  it.each(["JPA", "JPB"] as const)(
    "%s metadataとsummaryをsource表現のままparseする",
    (packageType) => {
      const result = parseAbstract(
        packageType,
        fictionalAbstractCsv(packageType),
      );

      expect(result.status).toBe("success");
      expect(result.recordCount).toBe(2);
      expect(result.records[0].rawRecord).toBe(
        `${packageType},20990228,FICTIONAL-ISSUE-0001,01122`,
      );
      expect(result.records[0].sourceCells).toEqual([
        packageType,
        "20990228",
        "FICTIONAL-ISSUE-0001",
        "01122",
      ]);
      expect(result.records[0].projection).toEqual({
        recordType: "metadata",
        packageCode: packageType,
        publicationDate: "20990228",
        issueNumber: "FICTIONAL-ISSUE-0001",
        issueControlValue: "01122",
      });
      expect(result.records[1].projection).toEqual(
        expect.objectContaining({
          recordType: "summary",
          publicationNumberRange: "FICTIONAL-RANGE-0001",
          documentCount: expect.objectContaining({
            sourceValue: packageType === "JPA" ? "00001" : "00002",
          }),
        }),
      );
    },
  );

  it.each([
    ["公開特許公報（特開）", "P_A1"],
    ["補正の掲載（公開特許公報）", "P_A5"],
    ["公表特許公報（特表）", "P_P1"],
    ["国際公開後における補正の掲載", "P_P5"],
  ] as const)("JPA known section %sを%sへ分類する", (name, section) => {
    const csv =
      "JPA,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
      `${name},FICTIONAL-RANGE-0001,00001\r\n`;
    const result = parseAbstract("JPA", csv);

    expect(result.status).toBe("success");
    expect(result.records[1].projection).toEqual(
      expect.objectContaining({ section }),
    );
  });

  it("section照合では末尾ASCII spaceだけを除去する", () => {
    const base = "JPA,20990228,FICTIONAL-ISSUE-0001,01122\r\n";
    const padded = parseAbstract(
      "JPA",
      `${base}公開特許公報（特開）   ,FICTIONAL-RANGE-0001,00001\r\n`,
    );
    const tabbed = parseAbstract(
      "JPA",
      `${base}公開特許公報（特開）\t,FICTIONAL-RANGE-0001,00001\r\n`,
    );
    const fullWidth = parseAbstract(
      "JPA",
      `${base}公開特許公報（特開）　,FICTIONAL-RANGE-0001,00001\r\n`,
    );

    expect(padded.status).toBe("success");
    expect(padded.records[1].sourceCells[0]).toBe(
      "公開特許公報（特開）   ",
    );
    expect(padded.records[1].projection).toEqual(
      expect.objectContaining({
        sectionName: "公開特許公報（特開）   ",
        normalizedSectionName: "公開特許公報（特開）",
      }),
    );
    expect(tabbed.status).toBe("review_required");
    expect(fullWidth.status).toBe("review_required");
    expect(tabbed.records[1].issues.map((issue) => issue.code)).toContain(
      "unknown_section",
    );
  });

  it("JPB semicolon listの順序とduplicateを保持し、空itemをfailedにする", () => {
    const valid = parseAbstract(
      "JPB",
      "JPB,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
        "特許公報,FICTIONAL-RANGE-0001,00003,FICTIONAL-A;FICTIONAL-A; FICTIONAL-B,\r\n",
    );
    const invalid = parseAbstract(
      "JPB",
      "JPB,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
        "特許公報,FICTIONAL-RANGE-0001,00003,FICTIONAL-A;;FICTIONAL-B,\r\n",
    );

    expect(valid.status).toBe("success");
    expect(valid.records[1].projection).toEqual(
      expect.objectContaining({
        missingNumbersInRange: {
          sourceValue: "FICTIONAL-A;FICTIONAL-A; FICTIONAL-B",
          values: ["FICTIONAL-A", "FICTIONAL-A", " FICTIONAL-B"],
        },
      }),
    );
    expect(invalid.status).toBe("failed");
    expect(invalid.records[1].issues.map((issue) => issue.code)).toContain(
      "invalid_semicolon_list",
    );
  });

  it("package/date/count/列数違反をstable issueへ分類する", () => {
    const result = parseAbstract(
      "JPA",
      "JPB,21000229,,01122,FICTIONAL-EXTRA\r\n" +
        "FICTIONAL-UNKNOWN,,001,FICTIONAL-EXTRA\r\n",
    );
    const codes = result.records.flatMap((record) =>
      record.issues.map((issue) => issue.code),
    );

    expect(result.status).toBe("failed");
    expect(codes).toEqual(
      expect.arrayContaining([
        "column_count_mismatch",
        "package_code_mismatch",
        "invalid_date",
        "required_field_empty",
        "unknown_section",
        "invalid_decimal",
      ]),
    );
    expect(result.records.every((record) => record.projection === null)).toBe(
      true,
    );
    expect(result.records[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_code_mismatch",
          recordOrdinal: 1,
          field: "packageCode",
        }),
        expect.objectContaining({
          code: "invalid_date",
          recordOrdinal: 1,
          field: "publicationDate",
        }),
        expect.objectContaining({
          code: "required_field_empty",
          recordOrdinal: 1,
          field: "issueNumber",
        }),
      ]),
    );
    expect(result.records[1].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown_section",
          recordOrdinal: 2,
          field: "sectionName",
        }),
        expect.objectContaining({
          code: "required_field_empty",
          recordOrdinal: 2,
          field: "publicationNumberRange",
        }),
        expect.objectContaining({
          code: "invalid_decimal",
          recordOrdinal: 2,
          field: "documentCount",
        }),
      ]),
    );
  });

  it("空sectionNameをunknown reviewだけでなくrequired failureにする", () => {
    const result = parseAbstract(
      "JPA",
      "JPA,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
        ",FICTIONAL-RANGE-0001,00001\r\n",
    );

    expect(result.status).toBe("failed");
    expect(result.records[1].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["required_field_empty", "unknown_section"]),
    );
  });

  it.each(["toString", "constructor", "__proto__"])(
    "prototype由来のsection名%sをknown値と誤認しない",
    (sectionName) => {
      const result = parseAbstract(
        "JPA",
        "JPA,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
          `${sectionName},FICTIONAL-RANGE-0001,00001\r\n`,
      );

      expect(result.status).toBe("review_required");
      expect(result.records[1].issues.map((issue) => issue.code)).toContain(
        "unknown_section",
      );
      expect(result.records[1].projection).toEqual(
        expect.objectContaining({ section: null }),
      );
    },
  );

  it("metadata-onlyをrequired_record_missingでfailedにする", () => {
    const result = parseAbstract(
      "JPA",
      "JPA,20990228,FICTIONAL-ISSUE-0001,01122\r\n",
    );

    expect(result.status).toBe("failed");
    expect(result.issues.map((issue) => issue.code)).toContain(
      "required_record_missing",
    );
  });

  it("同じnormalized sectionの全recordへduplicate reviewを付ける", () => {
    const result = parseAbstract(
      "JPA",
      fictionalAbstractCsv("JPA") +
        "公開特許公報（特開）  ,FICTIONAL-RANGE-0002,00002\r\n",
    );

    expect(result.status).toBe("review_required");
    expect(
      result.records.slice(1).map((record) =>
        record.issues.map((issue) => issue.code),
      ),
    ).toEqual([
      expect.arrayContaining(["duplicate_section"]),
      expect.arrayContaining(["duplicate_section"]),
    ]);
  });
});
