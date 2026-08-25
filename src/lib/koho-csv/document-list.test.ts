import { describe, expect, it } from "vitest";

import { parseKohoCsv } from "./index";
import {
  FICTIONAL_LIMITS,
  fictionalCsvBytes,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-csv";

function parseDocumentList(packageType: "JPA" | "JPB", csv: string) {
  const result = parseKohoCsv({
    packageType,
    entryPath: "DOCUMENT_LIST.csv",
    bytes: fictionalCsvBytes(csv),
    limits: FICTIONAL_LIMITS,
  });
  if (result.logicalFile !== "DOCUMENT_LIST") {
    throw new Error("expected a DOCUMENT_LIST result");
  }
  return result;
}

describe("parseKohoCsv DOCUMENT_LIST", () => {
  it.each(["JPA", "JPB"] as const)(
    "%s known kindを4列projectionへ保持する",
    (packageType) => {
      const result = parseDocumentList(
        packageType,
        fictionalDocumentListCsv(packageType),
      );

      expect(result.status).toBe("success");
      expect(result.records[0].projection).toEqual({
        countryCode: { sourceValue: "JP", knownValue: "JP" },
        publicationNumber: "0000-FICTIONAL-PUBLICATION-0001",
        kindCode: {
          sourceValue: packageType === "JPA" ? "A" : "B1",
          knownValue: packageType === "JPA" ? "A" : "B1",
        },
        issuePublicationDate: "20990228",
      });
    },
  );

  it.each([
    ["JPA", "A"],
    ["JPA", "A5"],
    ["JPB", "B1"],
    ["JPB", "B2"],
  ] as const)("%sの%sをknown kindとする", (packageType, kind) => {
    const result = parseDocumentList(
      packageType,
      `JP,FICTIONAL-PUBLICATION,${kind},20990228\r\n`,
    );
    expect(result.status).toBe("success");
  });

  it.each([
    ["JPA", "B1"],
    ["JPA", "B2"],
    ["JPB", "A"],
    ["JPB", "A5"],
  ] as const)("%sでopposite known kind %sをfailedにする", (packageType, kind) => {
    const result = parseDocumentList(
      packageType,
      `JP,FICTIONAL-PUBLICATION,${kind},20990228\r\n`,
    );

    expect(result.status).toBe("failed");
    expect(result.records[0].issues.map((issue) => issue.code)).toContain(
      "package_kind_mismatch",
    );
  });

  it("unknown kindとunknown countryを区別する", () => {
    const unknown = parseDocumentList(
      "JPA",
      "ZZ,FICTIONAL-PUBLICATION,FICTIONAL-KIND,20990228\r\n",
    );

    expect(unknown.status).toBe("review_required");
    expect(unknown.records[0].issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unknown_country_code", "unknown_kind"]),
    );
    expect(unknown.records[0].projection).toEqual(
      expect.objectContaining({
        countryCode: { sourceValue: "ZZ", knownValue: null },
        kindCode: { sourceValue: "FICTIONAL-KIND", knownValue: null },
      }),
    );
  });

  it.each(["0000123", "=FICTIONAL(0000123)"])(
    "opaque publication number %sを変換しない",
    (source) => {
    const result = parseDocumentList(
      "JPA",
      `JP,"${source}",A,20990228\r\n`,
    );

    expect(result.status).toBe("success");
    expect(result.records[0].sourceCells[1]).toBe(source);
    expect(result.records[0].projection?.publicationNumber).toBe(source);
    },
  );

  it("空publication、invalid date、列数不一致をfailedにする", () => {
    const result = parseDocumentList(
      "JPA",
      "JP,,A,21000229,FICTIONAL-EXTRA\r\n",
    );
    const codes = result.records[0].issues.map((issue) => issue.code);

    expect(result.status).toBe("failed");
    expect(codes).toEqual(
      expect.arrayContaining([
        "required_field_empty",
        "invalid_date",
        "column_count_mismatch",
      ]),
    );
    expect(result.records[0].sourceCells).toEqual([
      "JP",
      "",
      "A",
      "21000229",
      "FICTIONAL-EXTRA",
    ]);
    expect(result.records[0].projection).toBeNull();
  });

  it("空countryとkindをfield別required failureにする", () => {
    const result = parseDocumentList(
      "JPA",
      ",FICTIONAL-PUBLICATION,,20990228\r\n",
    );

    expect(result.status).toBe("failed");
    expect(
      result.records[0].issues
        .filter((issue) => issue.code === "required_field_empty")
        .map((issue) => issue.field),
    ).toEqual(["countryCode", "kindCode"]);
    expect(result.records[0].projection).toBeNull();
  });

  it("完全一致duplicateにはconflictを付けない", () => {
    const row = "JP,FICTIONAL-DUPLICATE-SAME,A,20990228\r\n";
    const result = parseDocumentList("JPA", row + row);

    expect(result.status).toBe("review_required");
    for (const record of result.records) {
      const codes = record.issues.map((issue) => issue.code);
      expect(codes).toContain("duplicate_publication_number");
      expect(codes).not.toContain("publication_record_conflict");
    }
  });

  it.each([
    ["kind", "A5", "20990228"],
    ["date", "A", "20990301"],
  ] as const)("duplicateの%sだけが異なる場合も全recordをconflictにする", (
    _difference,
    secondKind,
    secondDate,
  ) => {
    const result = parseDocumentList(
      "JPA",
      "JP,FICTIONAL-DUPLICATE,A,20990228\r\n" +
        `JP,FICTIONAL-DUPLICATE,${secondKind},${secondDate}\r\n`,
    );

    expect(result.status).toBe("review_required");
    expect(result.records).toHaveLength(2);
    for (const record of result.records) {
      expect(record.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          "duplicate_publication_number",
          "publication_record_conflict",
        ]),
      );
    }
  });
});
