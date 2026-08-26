import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseKohoCsv,
  type KohoCsvAbstractMetadataProjection,
  type KohoCsvAbstractProjection,
  type KohoCsvAbstractRecord,
  type KohoCsvAbstractResult,
  type KohoCsvAbstractSummaryProjection,
  type KohoCsvContents1Applicant,
  type KohoCsvContents1Projection,
  type KohoCsvContents1Record,
  type KohoCsvContents1Result,
  type KohoCsvContents2Projection,
  type KohoCsvContents2Record,
  type KohoCsvContents2Result,
  type KohoCsvContractAbstractRecord,
  type KohoCsvContractAbstractResult,
  type KohoCsvContractAbstractSemantic,
  type KohoCsvContractContents1Record,
  type KohoCsvContractContents1Result,
  type KohoCsvContractContents1Semantic,
  type KohoCsvContractContents2Record,
  type KohoCsvContractContents2Result,
  type KohoCsvContractContents2Semantic,
  type KohoCsvContractDocumentListRecord,
  type KohoCsvContractDocumentListResult,
  type KohoCsvContractDocumentListSemantic,
  type KohoCsvContractEncodingMetadata,
  type KohoCsvContractIssue,
  type KohoCsvContractIssueCode,
  type KohoCsvContractLimits,
  type KohoCsvContractLineEndingMetadata,
  type KohoCsvContractLogicalFile,
  type KohoCsvContractPackageType,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
  type KohoCsvContractRecord,
  type KohoCsvContractResultBase,
  type KohoCsvContractSourceMetadata,
  type KohoCsvContractStatus,
  type KohoCsvDecimalValue,
  type KohoCsvDocumentListProjection,
  type KohoCsvDocumentListRecord,
  type KohoCsvDocumentListResult,
  type KohoCsvEncodingMetadata,
  type KohoCsvIssue,
  type KohoCsvIssueCode,
  type KohoCsvKnownKind,
  type KohoCsvLimits,
  type KohoCsvLineEndingMetadata,
  type KohoCsvLogicalFile,
  type KohoCsvOptionalString,
  type KohoCsvPackageType,
  type KohoCsvParseInput,
  type KohoCsvParseResult,
  type KohoCsvRecord,
  type KohoCsvSection,
  type KohoCsvStatus,
  type KohoCsvUnclassifiedFailedResult,
  type KohoCsvUnclassifiedResult,
  type KohoCsvUnsupportedResult,
} from "./index";
import { parseKohoCsv as parseLegacyKohoCsv } from "./parser";
import type {
  KohoCsvAbstractMetadataProjection as LegacyAbstractMetadataProjection,
  KohoCsvAbstractProjection as LegacyAbstractProjection,
  KohoCsvAbstractRecord as LegacyAbstractRecord,
  KohoCsvAbstractResult as LegacyAbstractResult,
  KohoCsvAbstractSummaryProjection as LegacyAbstractSummaryProjection,
  KohoCsvContents1Applicant as LegacyContents1Applicant,
  KohoCsvContents1Projection as LegacyContents1Projection,
  KohoCsvContents1Record as LegacyContents1Record,
  KohoCsvContents1Result as LegacyContents1Result,
  KohoCsvContents2Projection as LegacyContents2Projection,
  KohoCsvContents2Record as LegacyContents2Record,
  KohoCsvContents2Result as LegacyContents2Result,
  KohoCsvDecimalValue as LegacyDecimalValue,
  KohoCsvDocumentListProjection as LegacyDocumentListProjection,
  KohoCsvDocumentListRecord as LegacyDocumentListRecord,
  KohoCsvDocumentListResult as LegacyDocumentListResult,
  KohoCsvEncodingMetadata as LegacyEncodingMetadata,
  KohoCsvIssue as LegacyIssue,
  KohoCsvIssueCode as LegacyIssueCode,
  KohoCsvKnownKind as LegacyKnownKind,
  KohoCsvLimits as LegacyLimits,
  KohoCsvLineEndingMetadata as LegacyLineEndingMetadata,
  KohoCsvLogicalFile as LegacyLogicalFile,
  KohoCsvOptionalString as LegacyOptionalString,
  KohoCsvPackageType as LegacyPackageType,
  KohoCsvParseInput as LegacyParseInput,
  KohoCsvParseResult as LegacyParseResult,
  KohoCsvRecord as LegacyRecord,
  KohoCsvSection as LegacySection,
  KohoCsvStatus as LegacyStatus,
  KohoCsvUnclassifiedFailedResult as LegacyUnclassifiedFailedResult,
  KohoCsvUnclassifiedResult as LegacyUnclassifiedResult,
  KohoCsvUnsupportedResult as LegacyUnsupportedResult,
} from "./types";
import {
  FICTIONAL_LIMITS,
  fictionalAbstractCsv,
  fictionalCsvBytes,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-csv";

const CONTRACT_LIMITS: KohoCsvContractLimits = {
  maxInputBytes: 100_000,
  maxRecords: 100,
  maxColumnsPerRecord: 100,
  maxCellCharacters: 10_000,
  maxTotalCharacters: 50_000,
};

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
    const candidate = String(Array.from(rawRecord(stable)).length + 1);
    if (stable[0] === candidate) return stable;
    stable[0] = candidate;
  }
  throw new Error("fictional record length did not stabilize");
}

function fictionalContents1Csv(): string {
  const cells = withStableRecordLength([
    "0",
    "A1",
    "FICTIONAL-PUBLICATION-0001",
    "FICTIONAL-APPLICATION-0001",
    "0",
    "0",
    "17",
    "FICTIONAL-TITLE-1",
    "0",
  ]);
  return `${rawRecord(cells)}\r\n`;
}

function fictionalContents2Csv(): string {
  const cells = withStableRecordLength([
    "0",
    "A1",
    "FICTIONAL-PUBLICATION-0001",
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
    "FICTIONAL-TITLE-1",
    "FICTIONAL-LOCATION-1",
    "FICTIONAL-PARTY-0001",
    "FICTIONAL-APPLICANT-1",
  ]);
  return `${rawRecord(cells)}\r\n`;
}

function legacyInput(
  entryPath: string,
  source: string | Uint8Array,
  limits: KohoCsvLimits = FICTIONAL_LIMITS,
): KohoCsvParseInput {
  return {
    packageType: "JPA",
    entryPath,
    bytes: typeof source === "string" ? fictionalCsvBytes(source) : source,
    limits,
  };
}

describe("PR #39 public type compatibility", () => {
  it("keeps every unprefixed public type equal to ./types", () => {
    expectTypeOf<KohoCsvAbstractMetadataProjection>().toEqualTypeOf<LegacyAbstractMetadataProjection>();
    expectTypeOf<KohoCsvAbstractProjection>().toEqualTypeOf<LegacyAbstractProjection>();
    expectTypeOf<KohoCsvAbstractRecord>().toEqualTypeOf<LegacyAbstractRecord>();
    expectTypeOf<KohoCsvAbstractResult>().toEqualTypeOf<LegacyAbstractResult>();
    expectTypeOf<KohoCsvAbstractSummaryProjection>().toEqualTypeOf<LegacyAbstractSummaryProjection>();
    expectTypeOf<KohoCsvContents1Applicant>().toEqualTypeOf<LegacyContents1Applicant>();
    expectTypeOf<KohoCsvContents1Projection>().toEqualTypeOf<LegacyContents1Projection>();
    expectTypeOf<KohoCsvContents1Record>().toEqualTypeOf<LegacyContents1Record>();
    expectTypeOf<KohoCsvContents1Result>().toEqualTypeOf<LegacyContents1Result>();
    expectTypeOf<KohoCsvContents2Projection>().toEqualTypeOf<LegacyContents2Projection>();
    expectTypeOf<KohoCsvContents2Record>().toEqualTypeOf<LegacyContents2Record>();
    expectTypeOf<KohoCsvContents2Result>().toEqualTypeOf<LegacyContents2Result>();
    expectTypeOf<KohoCsvDecimalValue>().toEqualTypeOf<LegacyDecimalValue>();
    expectTypeOf<KohoCsvDocumentListProjection>().toEqualTypeOf<LegacyDocumentListProjection>();
    expectTypeOf<KohoCsvDocumentListRecord>().toEqualTypeOf<LegacyDocumentListRecord>();
    expectTypeOf<KohoCsvDocumentListResult>().toEqualTypeOf<LegacyDocumentListResult>();
    expectTypeOf<KohoCsvEncodingMetadata>().toEqualTypeOf<LegacyEncodingMetadata>();
    expectTypeOf<KohoCsvIssue>().toEqualTypeOf<LegacyIssue>();
    expectTypeOf<KohoCsvIssueCode>().toEqualTypeOf<LegacyIssueCode>();
    expectTypeOf<KohoCsvKnownKind>().toEqualTypeOf<LegacyKnownKind>();
    expectTypeOf<KohoCsvLimits>().toEqualTypeOf<LegacyLimits>();
    expectTypeOf<KohoCsvLineEndingMetadata>().toEqualTypeOf<LegacyLineEndingMetadata>();
    expectTypeOf<KohoCsvLogicalFile>().toEqualTypeOf<LegacyLogicalFile>();
    expectTypeOf<KohoCsvOptionalString>().toEqualTypeOf<LegacyOptionalString>();
    expectTypeOf<KohoCsvPackageType>().toEqualTypeOf<LegacyPackageType>();
    expectTypeOf<KohoCsvParseInput>().toEqualTypeOf<LegacyParseInput>();
    expectTypeOf<KohoCsvParseResult>().toEqualTypeOf<LegacyParseResult>();
    expectTypeOf<KohoCsvRecord<unknown>>().toEqualTypeOf<LegacyRecord<unknown>>();
    expectTypeOf<KohoCsvSection>().toEqualTypeOf<LegacySection>();
    expectTypeOf<KohoCsvStatus>().toEqualTypeOf<LegacyStatus>();
    expectTypeOf<KohoCsvUnclassifiedFailedResult>().toEqualTypeOf<LegacyUnclassifiedFailedResult>();
    expectTypeOf<KohoCsvUnclassifiedResult>().toEqualTypeOf<LegacyUnclassifiedResult>();
    expectTypeOf<KohoCsvUnsupportedResult>().toEqualTypeOf<LegacyUnsupportedResult>();
  });

  it("keeps the legacy overload last for Parameters and ReturnType", () => {
    expectTypeOf<Parameters<typeof parseKohoCsv>[0]>().toEqualTypeOf<KohoCsvParseInput>();
    expectTypeOf<ReturnType<typeof parseKohoCsv>>().toEqualTypeOf<KohoCsvParseResult>();
  });
});

describe("Issue #40 prefixed contract types", () => {
  it("exports the prefixed type surface and infers the contract overload", () => {
    expectTypeOf<KohoCsvContractPackageType>().toEqualTypeOf<KohoCsvPackageType>();
    expectTypeOf<KohoCsvContractLogicalFile>().toEqualTypeOf<
      "abstract" | "document_list" | "contents1" | "contents2"
    >();
    expectTypeOf<KohoCsvContractStatus>().toEqualTypeOf<
      "success" | "review_required" | "failed"
    >();
    expectTypeOf<KohoCsvContractIssueCode>().not.toBeNever();
    expectTypeOf<KohoCsvContractIssue>().not.toBeNever();
    expectTypeOf<KohoCsvContractEncodingMetadata>().not.toBeNever();
    expectTypeOf<KohoCsvContractLineEndingMetadata>().not.toBeNever();
    expectTypeOf<KohoCsvContractSourceMetadata>().not.toBeNever();
    expectTypeOf<KohoCsvContractRecord<unknown>>().not.toBeNever();
    expectTypeOf<KohoCsvContractAbstractSemantic>().not.toBeNever();
    expectTypeOf<KohoCsvContractDocumentListSemantic>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents1Semantic>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents2Semantic>().not.toBeNever();
    expectTypeOf<KohoCsvContractAbstractRecord>().not.toBeNever();
    expectTypeOf<KohoCsvContractDocumentListRecord>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents1Record>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents2Record>().not.toBeNever();
    expectTypeOf<KohoCsvContractAbstractResult>().not.toBeNever();
    expectTypeOf<KohoCsvContractDocumentListResult>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents1Result>().not.toBeNever();
    expectTypeOf<KohoCsvContractContents2Result>().not.toBeNever();
    expectTypeOf<
      KohoCsvContractResultBase<KohoCsvContractLogicalFile, unknown>
    >().not.toBeNever();

    const input: KohoCsvContractParseInput = {
      packageType: "JPA",
      logicalFile: "abstract",
      entryPath: "ABSTRACT.csv",
      csv: fictionalAbstractCsv("JPA"),
      limits: CONTRACT_LIMITS,
    };
    const result = parseKohoCsv(input);
    expectTypeOf(result).toEqualTypeOf<KohoCsvContractParseResult>();
    expect(result.logicalFile).toBe("abstract");
  });
});

describe("PR #39 runtime compatibility", () => {
  const logicalFileCases = [
    ["ABSTRACT", legacyInput("ABSTRACT.csv", fictionalAbstractCsv("JPA"))],
    [
      "DOCUMENT_LIST",
      legacyInput("DOCUMENT_LIST.csv", fictionalDocumentListCsv("JPA")),
    ],
    [
      "CONTENTS1",
      legacyInput("DOCUMENT/P_A1/CONTENTS1.csv", fictionalContents1Csv()),
    ],
    [
      "CONTENTS2",
      legacyInput("DOCUMENT/P_A1/CONTENTS2.csv", fictionalContents2Csv()),
    ],
  ] as const;

  it.each(logicalFileCases)(
    "keeps the %s public-wrapper result byte-for-byte compatible",
    (_logicalFile, input) => {
      expect(parseKohoCsv(input)).toEqual(parseLegacyKohoCsv(input));
    },
  );

  const failureCases: readonly [string, KohoCsvParseInput][] = [
    [
      "invalid limits",
      legacyInput("ABSTRACT.csv", fictionalAbstractCsv("JPA"), {
        ...FICTIONAL_LIMITS,
        maxCsvBytes: 0,
      }),
    ],
    ["unsafe path", legacyInput("../ABSTRACT.csv", fictionalAbstractCsv("JPA"))],
    ["unsupported path", legacyInput("FICTIONAL.csv", "FICTIONAL\r\n")],
    ["invalid UTF-8", legacyInput("ABSTRACT.csv", Uint8Array.from([0xff]))],
    ["malformed CSV", legacyInput("DOCUMENT_LIST.csv", '"FICTIONAL\r\n')],
    [
      "byte limit",
      legacyInput("DOCUMENT_LIST.csv", fictionalDocumentListCsv("JPA"), {
        ...FICTIONAL_LIMITS,
        maxCsvBytes: 1,
      }),
    ],
  ];

  it.each(failureCases)(
    "keeps the %s public-wrapper failure compatible",
    (_name, input) => {
      expect(parseKohoCsv(input)).toEqual(parseLegacyKohoCsv(input));
    },
  );

  it("gives a legacy input precedence over own contract-like extras", () => {
    const inputWithExtras = {
      ...legacyInput("ABSTRACT.csv", fictionalAbstractCsv("JPA")),
      csv: "FICTIONAL-CONTRACT-DECOY",
      logicalFile: "abstract" as const,
    };
    const legacyView: KohoCsvParseInput = inputWithExtras;

    expect(parseKohoCsv(legacyView)).toEqual(parseLegacyKohoCsv(legacyView));
  });

  it("ignores inherited contract-like properties for legacy dispatch", () => {
    const inheritedContractShape = {
      csv: "FICTIONAL-CONTRACT-DECOY",
      logicalFile: "abstract" as const,
    };
    const input = Object.assign(
      Object.create(inheritedContractShape) as object,
      legacyInput("ABSTRACT.csv", fictionalAbstractCsv("JPA")),
    ) as KohoCsvParseInput;

    expect(parseKohoCsv(input)).toEqual(parseLegacyKohoCsv(input));
  });
});
