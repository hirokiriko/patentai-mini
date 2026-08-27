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

function officialSectionField(label: string, section: string): string {
  const value = `${label}(${section})`;
  const width = Array.from(value).reduce(
    (sum, character) =>
      sum + (character.codePointAt(0)! <= 0x7f ? 1 : 2),
    0,
  );
  return `${value}${" ".repeat(80 - width)}`;
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
          documentCount: {
            sourceValue: packageType === "JPA" ? "00001" : "00002",
            value: packageType === "JPA" ? 1 : 2,
          },
        }),
      );
      if (packageType === "JPB") {
        expect(result.records[1].projection).toEqual(
          expect.objectContaining({
            missingNumbersInRange: {
              sourceValue: "FICTIONAL-MISSING-0001",
              values: ["FICTIONAL-MISSING-0001"],
            },
            includedNumbersOutsideRange: {
              sourceValue: "FICTIONAL-OUTSIDE-0001",
              values: ["FICTIONAL-OUTSIDE-0001"],
            },
          }),
        );
      }
    },
  );

  it("issueControlValueをopaqueに保持しmetadata分岐へ使用しない", () => {
    const result = parseAbstract(
      "JPA",
      "JPA,20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n" +
        "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001\r\n",
    );

    expect(result.status).toBe("success");
    expect(result.records[0].projection).toEqual(
      expect.objectContaining({
        issueControlValue: "FICTIONAL-CONTROL",
      }),
    );
    expect(result.records[1].projection).toEqual(
      expect.objectContaining({
        section: "P_A1",
        documentCount: { sourceValue: "00001", value: 1 },
      }),
    );
  });

  it("空issueControlValueをrequired failureにする", () => {
    const result = parseAbstract(
      "JPA",
      "JPA,20990228,FICTIONAL-ISSUE-0001,\r\n" +
        "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001\r\n",
    );

    expect(result.status).toBe("failed");
    expect(result.records[0].issues).toContainEqual(
      expect.objectContaining({
        code: "required_field_empty",
        field: "issueControlValue",
      }),
    );
  });

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

  it.each([
    ["JPA", "A_999"],
    ["JPB", "B_999"],
  ] as const)(
    "%sのJPO公報仕様version codeをsource保持したまま受理する",
    (packageType, packageCode) => {
      const summary =
        packageType === "JPA"
          ? "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001"
          : "特許公報,FICTIONAL-RANGE-0001,00001,,";
      const result = parseAbstract(
        packageType,
        `${packageCode},20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n` +
          `${summary}\r\n`,
      );

      expect(result.status).toBe("success");
      expect(result.packageType).toBe(packageType);
      expect(result.records[0].rawRecord).toBe(
        `${packageCode},20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL`,
      );
      expect(result.records[0].sourceCells[0]).toBe(packageCode);
      expect(result.records[0].projection).toEqual(
        expect.objectContaining({ packageCode }),
      );
    },
  );

  it.each([
    ["JPA", "公開特許公報", "P_A1"],
    ["JPA", "補正の掲載(公開特許公報)", "P_A5"],
    ["JPA", "公表特許公報", "P_P1"],
    ["JPA", "国際公開後における補正の掲載", "P_P5"],
    ["JPB", "特許公報", "P_B1"],
  ] as const)(
    "%sのJPO公式section format %sをcanonical sectionへ解決する",
    (packageType, label, section) => {
      const packageCode = packageType === "JPA" ? "A_999" : "B_999";
      const sectionName = officialSectionField(label, section);
      const summary =
        packageType === "JPA"
          ? `${sectionName},FICTIONAL-RANGE-0001,00001`
          : `${sectionName},FICTIONAL-RANGE-0001,00001,,`;
      const result = parseAbstract(
        packageType,
        `${packageCode},20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n` +
          `${summary}\r\n`,
      );

      expect(result.status).toBe("success");
      expect(result.records[1].sourceCells[0]).toBe(sectionName);
      expect(result.records[1].projection).toEqual(
        expect.objectContaining({
          sectionName,
          normalizedSectionName: sectionName.replace(/ +$/u, ""),
          section,
        }),
      );
    },
  );

  it.each([
    ["公開特許公報", "P_A1", 62],
    ["補正の掲載(公開特許公報)", "P_A5", 50],
    ["公表特許公報", "P_P1", 62],
    ["国際公開後における補正の掲載", "P_P5", 46],
    ["特許公報", "P_B1", 66],
  ] as const)(
    "JPO公式section format %sの固定幅paddingを仕様値どおりにする",
    (label, section, expectedPadding) => {
      expect(officialSectionField(label, section)).toBe(
        `${label}(${section})${" ".repeat(expectedPadding)}`,
      );
    },
  );

  it.each([
    ["JPA", "B_999"],
    ["JPB", "A_999"],
    ["JPA", "A_99"],
    ["JPA", "A_9999"],
    ["JPA", "A_９９９"],
    ["JPA", "A_999 "],
  ] as const)(
    "%sで不一致または不正な公報仕様version code %sを受理しない",
    (packageType, packageCode) => {
      const summary =
        packageType === "JPA"
          ? "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001"
          : "特許公報,FICTIONAL-RANGE-0001,00001,,";
      const result = parseAbstract(
        packageType,
        `${packageCode},20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n` +
          `${summary}\r\n`,
      );

      expect(result.status).toBe("failed");
      expect(result.records[0].sourceCells[0]).toBe(packageCode);
      expect(result.records[0].issues).toContainEqual(
        expect.objectContaining({
          code: "package_code_mismatch",
          field: "packageCode",
        }),
      );
    },
  );

  it("JPO公式section labelとdirectory codeの矛盾を受理しない", () => {
    const sectionName = officialSectionField("公開特許公報", "P_P1");
    const result = parseAbstract(
      "JPA",
      "A_999,20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n" +
        `${sectionName},FICTIONAL-RANGE-0001,00001\r\n`,
    );

    expect(result.status).toBe("review_required");
    expect(result.records[1].sourceCells[0]).toBe(sectionName);
    expect(result.records[1].projection).toEqual(
      expect.objectContaining({ section: null }),
    );
    expect(result.records[1].issues).toContainEqual(
      expect.objectContaining({
        code: "unknown_section",
        field: "sectionName",
      }),
    );
  });

  const paddedOfficialSection = officialSectionField("公開特許公報", "P_A1");
  it.each([
    ["unknown label", "架空公報(P_A1)"],
    ["full-width parentheses", "公開特許公報（P_A1）"],
    ["missing padding", "公開特許公報(P_A1)"],
    ["short padding", paddedOfficialSection.slice(0, -1)],
    ["long padding", `${paddedOfficialSection} `],
    ["trailing tab", "公開特許公報(P_A1)\t"],
    ["trailing full-width space", "公開特許公報(P_A1)　"],
  ])("非公式section syntax %sを受理しない", (_caseName, sectionName) => {
    const result = parseAbstract(
      "JPA",
      "A_999,20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n" +
        `${sectionName},FICTIONAL-RANGE-0001,00001\r\n`,
    );

    expect(result.status).toBe("review_required");
    expect(result.records[1].sourceCells[0]).toBe(sectionName);
    expect(result.records[1].issues).toContainEqual(
      expect.objectContaining({ code: "unknown_section" }),
    );
  });

  it("同じcanonical sectionのlegacy名とJPO公式formatをduplicateにする", () => {
    const officialSectionName = officialSectionField("公開特許公報", "P_A1");
    const result = parseAbstract(
      "JPA",
      "A_999,20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n" +
        "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001\r\n" +
        `${officialSectionName},FICTIONAL-RANGE-0002,00002\r\n`,
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

  it("同じcanonical sectionのfailed recordもduplicateから除外しない", () => {
    const officialSectionName = officialSectionField("公開特許公報", "P_A1");
    const result = parseAbstract(
      "JPA",
      "A_999,20990228,FICTIONAL-ISSUE-0001,FICTIONAL-CONTROL\r\n" +
        "公開特許公報（特開）,FICTIONAL-RANGE-0001,00001\r\n" +
        `${officialSectionName},FICTIONAL-RANGE-0002,001\r\n`,
    );

    expect(result.status).toBe("failed");
    expect(result.records[2].issues).toContainEqual(
      expect.objectContaining({ code: "invalid_decimal" }),
    );
    expect(
      result.records.slice(1).map((record) =>
        record.issues.map((issue) => issue.code),
      ),
    ).toEqual([
      expect.arrayContaining(["duplicate_section"]),
      expect.arrayContaining(["duplicate_section"]),
    ]);
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
        "特許公報,FICTIONAL-RANGE-0001,00003,FICTIONAL-A;FICTIONAL-A; FICTIONAL-B,FICTIONAL-OUT;FICTIONAL-OUT\r\n",
    );
    const invalid = parseAbstract(
      "JPB",
      "JPB,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
        "特許公報,FICTIONAL-RANGE-0001,00003,FICTIONAL-A;;FICTIONAL-B,\r\n",
    );
    const invalidIncluded = parseAbstract(
      "JPB",
      "JPB,20990228,FICTIONAL-ISSUE-0001,01122\r\n" +
        "特許公報,FICTIONAL-RANGE-0001,00003,,FICTIONAL-OUT;;FICTIONAL-OUT\r\n",
    );

    expect(valid.status).toBe("success");
    expect(valid.records[1].projection).toEqual(
      expect.objectContaining({
        missingNumbersInRange: {
          sourceValue: "FICTIONAL-A;FICTIONAL-A; FICTIONAL-B",
          values: ["FICTIONAL-A", "FICTIONAL-A", " FICTIONAL-B"],
        },
        includedNumbersOutsideRange: {
          sourceValue: "FICTIONAL-OUT;FICTIONAL-OUT",
          values: ["FICTIONAL-OUT", "FICTIONAL-OUT"],
        },
      }),
    );
    expect(invalid.status).toBe("failed");
    expect(invalid.records[1].issues.map((issue) => issue.code)).toContain(
      "invalid_semicolon_list",
    );
    expect(invalidIncluded.status).toBe("failed");
    expect(invalidIncluded.records[1].issues).toContainEqual(
      expect.objectContaining({
        code: "invalid_semicolon_list",
        field: "includedNumbersOutsideRange",
      }),
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
