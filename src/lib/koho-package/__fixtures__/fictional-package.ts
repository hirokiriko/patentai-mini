import { buildZip } from "../../koho-zip/__fixtures__/zip-builder";
import { buildFictionalFullPublicationXml, fictionalPrimaryEntryPath } from "../../koho-xml/__fixtures__/fictional-koho";
import type { KohoPackageLimits, KohoPackageType } from "../types";

export const FICTIONAL_PACKAGE_LIMITS: KohoPackageLimits = {
  zip: {
    maxSourceBytes: 2_000_000,
    maxCentralDirectoryBytes: 200_000,
    maxEntries: 100,
    maxTotalCompressedBytes: 1_500_000,
    maxTotalUncompressedBytes: 1_500_000,
    maxEntryCompressedBytes: 1_000_000,
    maxEntryUncompressedBytes: 1_000_000,
    maxTotalReadUncompressedBytes: 1_500_000,
  },
  csv: {
    maxInputBytes: 100_000,
    maxRecords: 100,
    maxColumnsPerRecord: 100,
    maxCellCharacters: 10_000,
    maxTotalCharacters: 50_000,
  },
  xml: {
    maxXmlBytes: 1_000_000,
    maxDepth: 64,
    maxElements: 10_000,
    maxTextBytes: 500_000,
  },
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
    const value = String(Array.from(rawRecord(stable)).length + 1);
    if (stable[0] === value) return stable;
    stable[0] = value;
  }
  throw new Error("fictional record length did not stabilize");
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

export function fictionalAbstractCsv(packageType: KohoPackageType): string {
  if (packageType === "JPA") {
    return (
      "JPA,20990111,FICTIONAL-ISSUE-0001,01122\r\n" +
      "公開特許公報（特開）,FICTIONAL-RANGE-OPAQUE,00001\r\n"
    );
  }
  return (
    "JPB,20990311,FICTIONAL-ISSUE-0002,01122\r\n" +
    "特許公報,FICTIONAL-RANGE-OPAQUE,00001,,\r\n"
  );
}

export function fictionalOfficialAbstractCsv(
  packageType: KohoPackageType,
): string {
  const packageCode = packageType === "JPA" ? "A_999" : "B_999";
  const sections =
    packageType === "JPA"
      ? ([
          ["公開特許公報", "P_A1", "00001"],
          ["補正の掲載(公開特許公報)", "P_A5", "00000"],
          ["公表特許公報", "P_P1", "00000"],
          ["国際公開後における補正の掲載", "P_P5", "00000"],
        ] as const)
      : ([["特許公報", "P_B1", "00001"]] as const);
  const summaries = sections.map(([label, section, count]) => {
    const sectionName = officialSectionField(label, section);
    return packageType === "JPA"
      ? `${sectionName},FICTIONAL-RANGE-${section},${count}`
      : `${sectionName},FICTIONAL-RANGE-${section},${count},,`;
  });
  return (
    `${packageCode},20990228,FICTIONAL-ISSUE-SPEC,FICTIONAL-CONTROL\r\n` +
    `${summaries.join("\r\n")}\r\n`
  );
}

export function fictionalDocumentListCsv(packageType: KohoPackageType): string {
  return packageType === "JPA"
    ? "JP,2099000001,A,20990111\r\n"
    : "JP,0009999991,B1,20990311\r\n";
}

export function fictionalContents1Csv(
  packageType: KohoPackageType,
  publicationNumber?: string,
): string {
  const cells = withStableRecordLength([
    "0",
    packageType === "JPA" ? "A1" : "B1",
    publicationNumber ?? (packageType === "JPA" ? "2099000001" : "9999991"),
    ...(packageType === "JPB" ? ["20990301"] : []),
    packageType === "JPA"
      ? "FICTIONAL-APPLICATION-A1-0001"
      : "FICTIONAL-APPLICATION-B1-0001",
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

export function fictionalContents2Csv(
  packageType: KohoPackageType,
  publicationNumber?: string,
): string {
  const cells = withStableRecordLength([
    "0",
    packageType === "JPA" ? "A1" : "B1",
    publicationNumber ?? (packageType === "JPA" ? "2099000001" : "9999991"),
    ...(packageType === "JPB" ? ["20990301"] : []),
    packageType === "JPA"
      ? "FICTIONAL-APPLICATION-A1-0001"
      : "FICTIONAL-APPLICATION-B1-0001",
    "0",
    " ",
    " ",
    " ",
    " ",
    " ",
    " ",
    " ",
    "FICTIONAL-CLASSIFICATION",
    "架空題名",
    "架空地",
    "FICTIONAL-PARTY-0001",
    "架空者",
  ]);
  return `${rawRecord(cells)}\r\n`;
}

export function buildMinimalFictionalPackage(
  packageType: KohoPackageType,
  options: {
    compressionMethod?: 0 | 8;
    includeContents1?: boolean;
    includeContents2?: boolean;
    includeNestedXml?: boolean;
    includeIgnoredEntries?: boolean;
    documentListCsv?: string;
    abstractCsv?: string;
    contents1Csv?: string;
    contents2Csv?: string;
  } = {},
): Buffer {
  const kind = packageType === "JPA" ? "A1" : "B1";
  const section = packageType === "JPA" ? "P_A1" : "P_B1";
  const compressionMethod = options.compressionMethod ?? 0;
  const entries = [
    {
      fileName: "ABSTRACT.csv",
      data: options.abstractCsv ?? fictionalAbstractCsv(packageType),
      compressionMethod,
    },
    {
      fileName: "DOCUMENT_LIST.csv",
      data: options.documentListCsv ?? fictionalDocumentListCsv(packageType),
      compressionMethod,
    },
  ];

  if (options.includeContents1 !== false) {
    entries.push({
      fileName: `DOCUMENT/${section}/CONTENTS1.csv`,
      data: options.contents1Csv ?? fictionalContents1Csv(packageType),
      compressionMethod,
    });
  }
  if (options.includeContents2 !== false) {
    entries.push({
      fileName: `DOCUMENT/${section}/CONTENTS2.csv`,
      data: options.contents2Csv ?? fictionalContents2Csv(packageType),
      compressionMethod,
    });
  }

  entries.push({
    fileName: fictionalPrimaryEntryPath(kind),
    data: buildFictionalFullPublicationXml(kind),
    compressionMethod,
  });

  if (options.includeNestedXml) {
    entries.push({
      fileName: `DOCUMENT/${section}/999900/999990/${packageType === "JPA" ? "2099000001" : "9999991"}/ATTACHMENT/NESTED.xml`,
      data: "<FICTIONAL-NESTED/>",
      compressionMethod,
    });
  }
  if (options.includeIgnoredEntries) {
    entries.push(
      {
        fileName: `DOCUMENT/${section}/999900/999990/${packageType === "JPA" ? "2099000001" : "9999991"}/image.png`,
        data: "FICTIONAL-IMAGE-BYTES",
        compressionMethod,
      },
      {
        fileName: "XSD/FICTIONAL.xsd",
        data: "<schema/>",
        compressionMethod,
      },
      {
        fileName: "LEGACY/FICTIONAL.app",
        data: "FICTIONAL-LEGACY",
        compressionMethod,
      },
    );
  }

  return buildZip({ entries }).bytes;
}
