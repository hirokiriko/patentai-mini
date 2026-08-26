import { describe, expect, it } from "vitest";

import {
  parseKohoCsv,
  type KohoCsvContractParseInput,
  type KohoCsvContractParseResult,
} from "../koho-csv";
import {
  buildZip,
  type ZipFixtureEntryInput,
} from "../koho-zip/__fixtures__/zip-builder";
import {
  KohoZipError,
  openKohoZip,
  type KohoZipEntry,
  type KohoZipReader,
  type KohoZipSummary,
} from "../koho-zip";
import {
  buildFictionalAmendmentXml,
  buildFictionalFullPublicationXml,
  fictionalPrimaryEntryPath,
} from "../koho-xml/__fixtures__/fictional-koho";
import { parseKohoXml, type KohoXmlParseInput } from "../koho-xml";
import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
  fictionalAbstractCsv,
  fictionalContents1Csv,
  fictionalContents2Csv,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-package";
import { parseKohoPackageWithDependencies } from "./orchestrator";
import type {
  KohoPackageLimits,
  KohoPackageParseInput,
  KohoPackageParseResult,
} from "./types";

const textEncoder = new TextEncoder();

function issueCodes(result: KohoPackageParseResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function minimalJpaEntries(
  options: {
    abstractCsv?: string;
    documentListCsv?: string;
    contents1Csv?: string;
    contents2Csv?: string;
    contents1Flags?: number;
    xml?: string;
  } = {},
): ZipFixtureEntryInput[] {
  return [
    {
      fileName: "ABSTRACT.csv",
      data: options.abstractCsv ?? fictionalAbstractCsv("JPA"),
    },
    {
      fileName: "DOCUMENT_LIST.csv",
      data: options.documentListCsv ?? fictionalDocumentListCsv("JPA"),
    },
    {
      fileName: "DOCUMENT/P_A1/CONTENTS1.csv",
      data: options.contents1Csv ?? fictionalContents1Csv("JPA"),
      ...(options.contents1Flags === undefined
        ? {}
        : { flags: options.contents1Flags, compressionMethod: 8 }),
    },
    {
      fileName: "DOCUMENT/P_A1/CONTENTS2.csv",
      data: options.contents2Csv ?? fictionalContents2Csv("JPA"),
    },
    {
      fileName: fictionalPrimaryEntryPath("A1"),
      data: options.xml ?? buildFictionalFullPublicationXml("A1"),
    },
  ];
}

function fakeEntry(
  id: number,
  normalizedPath: string,
  overrides: Partial<KohoZipEntry> = {},
): KohoZipEntry {
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const role = basename.endsWith(".csv")
    ? "csv"
    : basename.endsWith(".xml")
      ? "xml"
      : "other";
  return {
    id,
    rawFileNameBase64: "RklDVElPTkFM",
    decodedPath: normalizedPath,
    normalizedPath,
    isDirectory: false,
    compressionMethod: 0,
    compressedSize: 10,
    uncompressedSize: 10,
    crc32: 0,
    encrypted: false,
    role,
    pathCandidate: role === "xml" ? "primary_xml" : "none",
    canRead: true,
    issues: [],
    ...overrides,
  };
}

function summaryFor(entries: readonly KohoZipEntry[]): KohoZipSummary {
  const roleCounts = {
    directory: 0,
    xml: 0,
    csv: 0,
    schema: 0,
    image: 0,
    other: 0,
  };
  const candidateCounts = { primary_xml: 0, nested_xml: 0, none: 0 };
  for (const entry of entries) {
    roleCounts[entry.role] += 1;
    candidateCounts[entry.pathCandidate] += 1;
  }
  return {
    sourceType: "buffer",
    sourceName: null,
    sourceSize: 100,
    zip64: false,
    commentLength: 0,
    eocdTailBytesRead: 100,
    centralDirectoryOffset: 0,
    declaredCentralDirectorySize: 0,
    metadataBytesRead: 100,
    targetedMetadataBytesRead: 0,
    declaredEntryCount: entries.length,
    observedEntryCount: entries.length,
    totalDeclaredCompressedBytes: entries.reduce(
      (total, entry) => total + entry.compressedSize,
      0,
    ),
    totalDeclaredUncompressedBytes: entries.reduce(
      (total, entry) => total + entry.uncompressedSize,
      0,
    ),
    roleCounts,
    candidateCounts,
    encryptedEntryCount: entries.filter((entry) => entry.encrypted).length,
    unsupportedCompressionEntryCount: entries.filter(
      (entry) => entry.compressionMethod !== 0 && entry.compressionMethod !== 8,
    ).length,
  };
}

function packageInput(
  source: KohoPackageParseInput["source"] = {
    type: "buffer",
    bytes: new Uint8Array([1]),
  },
): KohoPackageParseInput {
  return {
    packageType: "JPA",
    source,
    limits: FICTIONAL_PACKAGE_LIMITS,
  };
}

function parseCsvWithEmptyDocumentList(
  input: KohoCsvContractParseInput,
): KohoCsvContractParseResult {
  const result = parseKohoCsv(input);
  if (input.logicalFile !== "document_list") return result;
  return {
    ...result,
    status: "success",
    issues: [],
    recordCount: 0,
    records: [],
  } as KohoCsvContractParseResult;
}

describe("package orchestration regression coverage", () => {
  it("maps a ZIP open error without exposing its raw source", async () => {
    const result = await parseKohoPackageWithDependencies(
      packageInput({
        type: "buffer",
        bytes: textEncoder.encode("FICTIONAL-NOT-A-ZIP"),
        sourceName: "FICTIONAL-SECRET-NAME.zip",
      }),
      {},
    );

    expect(result.status).toBe("failed");
    expect(result.zipSummary).toBeNull();
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "zip_open_failed",
        cause: { source: "zip", code: "invalid_zip" },
      }),
    );
    expect(JSON.stringify(result)).not.toContain("FICTIONAL-SECRET-NAME.zip");
  });

  it("stops all entry reads after an unsafe reader resource error", async () => {
    const entries = [
      fakeEntry(0, "ABSTRACT.csv"),
      fakeEntry(1, "DOCUMENT_LIST.csv"),
      fakeEntry(2, "DOCUMENT/P_A1/CONTENTS1.csv"),
      fakeEntry(3, fictionalPrimaryEntryPath("A1")),
    ];
    const readOrder: number[] = [];
    let closeCount = 0;
    const reader: KohoZipReader = {
      entries,
      summary: summaryFor(entries),
      async readEntryBytes(entryId) {
        readOrder.push(entryId);
        throw new KohoZipError("entry_read_limit");
      },
      async close() {
        closeCount += 1;
      },
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(result.status).toBe("failed");
    expect(readOrder).toEqual([0]);
    expect(closeCount).toBe(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "required_csv_unreadable",
        cause: { source: "zip", code: "entry_read_limit" },
      }),
    );
    expect(
      result.manifest.filter((entry) => entry.entryId > 0),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "not_processed" }),
      ]),
    );
  });

  it("fails and stops after an unsafe read error in a noncanonical known CSV", async () => {
    const entries = [
      fakeEntry(0, "ABSTRACT.csv"),
      fakeEntry(1, "DOCUMENT_LIST.csv"),
      fakeEntry(2, "AAA/CONTENTS1.csv"),
      fakeEntry(3, fictionalPrimaryEntryPath("A1")),
    ];
    const readOrder: number[] = [];
    let closeCount = 0;
    const reader: KohoZipReader = {
      entries,
      summary: summaryFor(entries),
      async readEntryBytes(entryId) {
        readOrder.push(entryId);
        if (entryId === 0) {
          return textEncoder.encode(fictionalAbstractCsv("JPA"));
        }
        if (entryId === 1) {
          return textEncoder.encode(fictionalDocumentListCsv("JPA"));
        }
        if (entryId === 2) {
          throw new KohoZipError("entry_size_mismatch");
        }
        throw new Error("primary XML must not be read");
      },
      async close() {
        closeCount += 1;
      },
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(result.status).toBe("failed");
    expect(readOrder).toEqual([0, 1, 2]);
    expect(closeCount).toBe(1);
    expect(result.manifest[2]).toEqual(
      expect.objectContaining({ processing: "unreadable", status: "failed" }),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "zip_entry_read_failed",
        status: "failed",
        normalizedPath: "AAA/CONTENTS1.csv",
        cause: { source: "zip", code: "entry_size_mismatch" },
      }),
    );
    expect(result.manifest[3]).toEqual(
      expect.objectContaining({ status: "not_processed" }),
    );
  });

  it("fails safely when a primary XML entry cannot be read and closes the reader", async () => {
    const entries = [
      fakeEntry(0, "ABSTRACT.csv"),
      fakeEntry(1, "DOCUMENT_LIST.csv"),
      fakeEntry(2, fictionalPrimaryEntryPath("A1")),
    ];
    const readOrder: number[] = [];
    let closeCount = 0;
    const reader: KohoZipReader = {
      entries,
      summary: summaryFor(entries),
      async readEntryBytes(entryId) {
        readOrder.push(entryId);
        if (entryId === 0) {
          return textEncoder.encode(fictionalAbstractCsv("JPA"));
        }
        if (entryId === 1) {
          return textEncoder.encode(fictionalDocumentListCsv("JPA"));
        }
        throw new KohoZipError("entry_size_mismatch");
      },
      async close() {
        closeCount += 1;
      },
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(result.status).toBe("failed");
    expect(readOrder).toEqual([0, 1, 2]);
    expect(closeCount).toBe(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "zip_entry_read_failed",
        status: "failed",
        normalizedPath: fictionalPrimaryEntryPath("A1"),
        cause: { source: "zip", code: "entry_size_mismatch" },
      }),
    );
  });

  it.each([
    ["success", buildFictionalFullPublicationXml("A1"), "success"],
    ["XML parser failure", "<FICTIONAL-BROKEN", "failed"],
  ] as const)(
    "closes the reader after %s",
    async (_caseName, xml, expectedStatus) => {
      const bytes = buildZip({ entries: minimalJpaEntries({ xml }) }).bytes;
      const actualReader = await openKohoZip({
        source: { type: "buffer", bytes },
        limits: FICTIONAL_PACKAGE_LIMITS.zip,
      });
      let closeCount = 0;
      const reader: KohoZipReader = {
        entries: actualReader.entries,
        summary: actualReader.summary,
        readEntryBytes: (entryId) => actualReader.readEntryBytes(entryId),
        async close() {
          closeCount += 1;
          await actualReader.close();
        },
      };

      const result = await parseKohoPackageWithDependencies(packageInput(), {
        openZip: async () => reader,
      });

      expect(result.status).toBe(expectedStatus);
      expect(closeCount).toBe(1);
    },
  );

  it("stops after a failed root parser and keeps its record-level CSV cause", async () => {
    const entries = [
      fakeEntry(0, "ABSTRACT.csv"),
      fakeEntry(1, "DOCUMENT_LIST.csv"),
      fakeEntry(2, "DOCUMENT/P_A1/CONTENTS1.csv"),
      fakeEntry(3, fictionalPrimaryEntryPath("A1")),
    ];
    const readOrder: number[] = [];
    let closeCount = 0;
    const reader: KohoZipReader = {
      entries,
      summary: summaryFor(entries),
      async readEntryBytes(entryId) {
        readOrder.push(entryId);
        if (entryId === 0) {
          return textEncoder.encode(
            fictionalAbstractCsv("JPA").replace("20990111", "20990230"),
          );
        }
        throw new Error("later entry must not be read");
      },
      async close() {
        closeCount += 1;
      },
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(result.status).toBe("failed");
    expect(readOrder).toEqual([0]);
    expect(closeCount).toBe(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "csv_parse_failed",
        recordNumber: 1,
        cause: { source: "csv", code: "invalid_date" },
      }),
    );
  });

  it("retains a close failure when summary access fails after open", async () => {
    let closeCount = 0;
    const reader: KohoZipReader = {
      entries: [],
      get summary(): KohoZipSummary {
        throw new KohoZipError("source_invalid");
      },
      async readEntryBytes() {
        throw new Error("entry read must not run");
      },
      async close() {
        closeCount += 1;
        throw new KohoZipError("reader_closed");
      },
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(closeCount).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "zip_open_failed",
          cause: { source: "zip", code: "source_invalid" },
        }),
        expect.objectContaining({
          code: "reader_close_failed",
          cause: { source: "zip", code: "reader_closed" },
        }),
      ]),
    );
  });

  it("compares a positive ABSTRACT summary against zero primary candidates", async () => {
    const bytes = buildZip({
      entries: [
        { fileName: "ABSTRACT.csv", data: fictionalAbstractCsv("JPA") },
        {
          fileName: "DOCUMENT_LIST.csv",
          data: fictionalDocumentListCsv("JPA"),
        },
      ],
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {
      parseCsv: parseCsvWithEmptyDocumentList,
    });

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("abstract_count_mismatch");
  });

  it("marks canonical CONTENTS records orphaned when primary candidates are zero", async () => {
    const abstractWithZero = fictionalAbstractCsv("JPA").replace(
      ",00001\r\n",
      ",00000\r\n",
    );
    const bytes = buildZip({
      entries: minimalJpaEntries({ abstractCsv: abstractWithZero }).filter(
        (entry) =>
          entry.fileName !== fictionalPrimaryEntryPath("A1"),
      ),
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {
      parseCsv: parseCsvWithEmptyDocumentList,
    });

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((issue) => issue.code === "contents_record_orphan"),
    ).toHaveLength(2);
    expect(issueCodes(result)).not.toContain("contents_file_missing");
  });

  it("keeps classification and typed causes for unreadable unselected entries", async () => {
    const encryptedFlags = 0x0801;
    const nestedPath =
      "DOCUMENT/P_A1/999900/999990/2099000001/SEQL/FICTIONAL.xml";
    const bytes = buildZip({
      entries: [
        ...minimalJpaEntries(),
        {
          fileName: nestedPath,
          data: "<FICTIONAL-NESTED/>",
          flags: encryptedFlags,
          compressionMethod: 8,
        },
        {
          fileName: "EXTRA/FICTIONAL.csv",
          data: "FICTIONAL-CSV",
          flags: encryptedFlags,
          compressionMethod: 8,
        },
        {
          fileName: "EXTRA/FICTIONAL.xml",
          data: "<FICTIONAL-XML/>",
          flags: encryptedFlags,
          compressionMethod: 8,
        },
      ],
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("review_required");
    expect(
      result.issues.filter((issue) => issue.code === "unreadable_attachment"),
    ).toHaveLength(3);
    expect(
      result.issues
        .filter((issue) => issue.code === "unreadable_attachment")
        .every(
          (issue) =>
            issue.cause?.source === "zip" &&
            issue.cause.code === "encrypted_entry",
        ),
    ).toBe(true);
    expect(
      result.manifest.find((entry) => entry.normalizedPath === nestedPath),
    ).toEqual(
      expect.objectContaining({
        processing: "counted_nested_xml",
        status: "review_required",
      }),
    );
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "unclassified_csv_entry",
        "unclassified_xml_entry",
      ]),
    );
  });

  it("never reads unknown CSV, nested or unclassified XML, schema, image, or other bodies", async () => {
    const nestedPath =
      "DOCUMENT/P_A1/999900/999990/2099000001/SEQL/FICTIONAL.xml";
    const unselectedPaths = [
      nestedPath,
      "EXTRA/FICTIONAL.csv",
      "EXTRA/FICTIONAL.xml",
      "XSD/FICTIONAL.xsd",
      "DOCUMENT/P_A1/999900/999990/2099000001/FICTIONAL.png",
      "OTHER/FICTIONAL.bin",
    ];
    const bytes = buildZip({
      entries: [
        ...minimalJpaEntries(),
        { fileName: nestedPath, data: "FICTIONAL-NESTED-BODY" },
        { fileName: "EXTRA/FICTIONAL.csv", data: "FICTIONAL-CSV-BODY" },
        { fileName: "EXTRA/FICTIONAL.xml", data: "FICTIONAL-XML-BODY" },
        { fileName: "XSD/FICTIONAL.xsd", data: "FICTIONAL-SCHEMA-BODY" },
        {
          fileName:
            "DOCUMENT/P_A1/999900/999990/2099000001/FICTIONAL.png",
          data: "FICTIONAL-IMAGE-BODY",
        },
        { fileName: "OTHER/FICTIONAL.bin", data: "FICTIONAL-OTHER-BODY" },
      ],
    }).bytes;
    const actualReader = await openKohoZip({
      source: { type: "buffer", bytes },
      limits: FICTIONAL_PACKAGE_LIMITS.zip,
    });
    const unselectedIds = actualReader.entries
      .filter((entry) => unselectedPaths.includes(entry.normalizedPath))
      .map((entry) => entry.id);
    const readIds: number[] = [];
    const reader: KohoZipReader = {
      entries: actualReader.entries,
      summary: actualReader.summary,
      async readEntryBytes(entryId) {
        readIds.push(entryId);
        return actualReader.readEntryBytes(entryId);
      },
      close: () => actualReader.close(),
    };

    const result = await parseKohoPackageWithDependencies(packageInput(), {
      openZip: async () => reader,
    });

    expect(unselectedIds).toHaveLength(unselectedPaths.length);
    expect(readIds.filter((entryId) => unselectedIds.includes(entryId))).toEqual(
      [],
    );
    expect(result.counts.nestedXmlCandidates).toBe(1);
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "unclassified_csv_entry",
        "unclassified_xml_entry",
      ]),
    );
  });

  it("does not report an unreadable canonical CONTENTS entry as missing", async () => {
    const bytes = buildZip({
      entries: minimalJpaEntries({ contents1Flags: 0x0801 }),
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("failed");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "zip_entry_read_failed",
        normalizedPath: "DOCUMENT/P_A1/CONTENTS1.csv",
        cause: { source: "zip", code: "encrypted_entry" },
      }),
    );
    expect(
      result.issues.some(
        (issue) =>
          issue.code === "contents_file_missing" &&
          issue.normalizedPath === "DOCUMENT/P_A1/CONTENTS1.csv",
      ),
    ).toBe(false);
  });

  it("matches a leading-zero B number before using an unknown DOCUMENT_LIST kind", async () => {
    const result = await parseKohoPackageWithDependencies(
      {
        packageType: "JPB",
        source: {
          type: "buffer",
          bytes: buildMinimalFictionalPackage("JPB", {
            documentListCsv: "JP,0009999991,FICTIONAL,20990311\r\n",
          }),
        },
        limits: FICTIONAL_PACKAGE_LIMITS,
      },
      {},
    );

    expect(issueCodes(result)).not.toContain("document_list_match_missing");
    expect(issueCodes(result)).not.toContain("document_list_orphan");
    expect(result.primaryXmlResults).toHaveLength(1);
    expect(result.primaryXmlResults[0].result.status).toBe("review_required");
  });

  it.each(["-", "‐", "‑", "‒", "–", "—", "―", " "])(
    "normalizes the DOCUMENT_LIST publication-number separator %s",
    async (separator) => {
      const result = await parseKohoPackageWithDependencies(packageInput({
        type: "buffer",
        bytes: buildMinimalFictionalPackage("JPA", {
          documentListCsv: `JP,20${separator}99000001,A,20990111\r\n`,
        }),
      }), {});

      expect(result.status).toBe("review_required");
      expect(issueCodes(result)).not.toContain("document_list_match_missing");
      expect(issueCodes(result)).not.toContain("document_list_orphan");
      expect(
        result.primaryXmlResults[0].result.issues.map((issue) => issue.code),
      ).not.toContain("index_hint_missing");
    },
  );

  it("uses path and XML identity to keep DOCUMENT_LIST kind A as P1", async () => {
    const metadata = fictionalAbstractCsv("JPA").split("\r\n")[0];
    const entries: ZipFixtureEntryInput[] = [
      {
        fileName: "ABSTRACT.csv",
        data:
          `${metadata}\r\n` +
          "公表特許公報（特表）,FICTIONAL-P1-RANGE,00001\r\n",
      },
      {
        fileName: "DOCUMENT_LIST.csv",
        data: "JP,wo 2099—000001,A,20990211\r\n",
      },
      {
        fileName: "DOCUMENT/P_P1/CONTENTS1.csv",
        data: fictionalContents1Csv("JPA", "WO2099000001"),
      },
      {
        fileName: "DOCUMENT/P_P1/CONTENTS2.csv",
        data: fictionalContents2Csv("JPA", "WO2099000001"),
      },
      {
        fileName: fictionalPrimaryEntryPath("P1"),
        data: buildFictionalFullPublicationXml("P1"),
      },
    ];
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("review_required");
    expect(result.primaryXmlResults[0].result).toMatchObject({
      status: "review_required",
      kind: "P1",
    });
    expect(
      result.primaryXmlResults[0].result.issues.map((issue) => issue.code),
    ).not.toContain("index_hint_missing");
  });

  it("normalizes NFC publication-number views without changing source values", async () => {
    const composed = "WOÉ2099000001";
    const decomposed = "WOE\u03012099000001";
    const metadata = fictionalAbstractCsv("JPA").split("\r\n")[0];
    const primaryPath =
      `DOCUMENT/P_P1/999900/999990/${composed}/${composed}.xml`;
    const entries: ZipFixtureEntryInput[] = [
      {
        fileName: "ABSTRACT.csv",
        data:
          `${metadata}\r\n` +
          "公表特許公報（特表）,FICTIONAL-NFC-RANGE,00001\r\n",
      },
      {
        fileName: "DOCUMENT_LIST.csv",
        data: `JP,${decomposed},A,20990211\r\n`,
      },
      {
        fileName: "DOCUMENT/P_P1/CONTENTS1.csv",
        data: fictionalContents1Csv("JPA", decomposed),
      },
      {
        fileName: "DOCUMENT/P_P1/CONTENTS2.csv",
        data: fictionalContents2Csv("JPA", decomposed),
      },
      {
        fileName: primaryPath,
        data: buildFictionalFullPublicationXml("P1", {
          publicationNumber: composed,
        }),
      },
    ];
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).not.toContain("document_list_match_missing");
    expect(issueCodes(result)).not.toContain("document_list_orphan");
    expect(
      result.primaryXmlResults[0].result.issues.map((issue) => issue.code),
    ).not.toContain("index_hint_missing");
    expect(JSON.stringify(result.csvResults)).toContain(decomposed);
    expect(JSON.stringify(result.primaryXmlResults)).toContain(composed);
  });

  it("reuses the same selected XML bytes for bootstrap and final parse", async () => {
    const bytes = buildMinimalFictionalPackage("JPA");
    const actualReader = await openKohoZip({
      source: { type: "buffer", bytes },
      limits: FICTIONAL_PACKAGE_LIMITS.zip,
    });
    const primaryEntryId = actualReader.entries.find(
      (entry) => entry.pathCandidate === "primary_xml",
    )!.id;
    const reads: number[] = [];
    const xmlInputs: KohoXmlParseInput[] = [];
    const reader: KohoZipReader = {
      entries: actualReader.entries,
      summary: actualReader.summary,
      async readEntryBytes(entryId) {
        reads.push(entryId);
        return actualReader.readEntryBytes(entryId);
      },
      close: () => actualReader.close(),
    };

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {
      openZip: async () => reader,
      parseXml(input) {
        xmlInputs.push(input);
        return parseKohoXml(input);
      },
    });

    expect(result.status).toBe("success");
    expect(reads.filter((entryId) => entryId === primaryEntryId)).toHaveLength(1);
    expect(xmlInputs).toHaveLength(2);
    expect(xmlInputs[0].indexHint).toBeUndefined();
    expect(xmlInputs[1].indexHint).toBeDefined();
    expect(xmlInputs[0].xml).toBe(xmlInputs[1].xml);
    expect(result.primaryXmlResults).toHaveLength(1);
  });

  it.each([
    ["malformed", "<FICTIONAL-BROKEN", "failed", "primary_xml_parse_failed"],
    [
      "unsupported",
      buildFictionalFullPublicationXml("A1").replaceAll(
        "UnexaminedPatentPublication",
        "FictionalUnknownPublication",
      ),
      "review_required",
      "primary_xml_unconfirmed",
    ],
  ] as const)(
    "rolls up a %s primary XML result",
    async (_caseName, xml, expectedStatus, expectedIssue) => {
      const bytes = buildZip({ entries: minimalJpaEntries({ xml }) }).bytes;
      const result = await parseKohoPackageWithDependencies(packageInput({
        type: "buffer",
        bytes,
      }), {});

      expect(result.status).toBe(expectedStatus);
      expect(issueCodes(result)).toContain(expectedIssue);
      expect(result.primaryXmlResults).toHaveLength(1);
    },
  );

  it("parses known noncanonical CSVs without using them as canonical substitutes", async () => {
    const entries = minimalJpaEntries().filter(
      (entry) => entry.fileName !== "DOCUMENT/P_A1/CONTENTS1.csv",
    );
    entries.push(
      {
        fileName: "DOCUMENT/P_A5/CONTENTS1.csv",
        data: fictionalContents1Csv("JPA"),
      },
      {
        fileName: "DOCUMENT/P_B1/CONTENTS2.csv",
        data: fictionalContents2Csv("JPA"),
      },
    );
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.csvResults.map((item) => item.normalizedPath)).toEqual(
      expect.arrayContaining([
        "DOCUMENT/P_A5/CONTENTS1.csv",
        "DOCUMENT/P_B1/CONTENTS2.csv",
      ]),
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "contents_file_missing",
        normalizedPath: "DOCUMENT/P_A1/CONTENTS1.csv",
      }),
    );
    expect(issueCodes(result)).toContain("package_section_mismatch");
  });

  it("parses P5 CONTENTS without treating them as canonical cross-check files", async () => {
    const documentListCsv =
      fictionalDocumentListCsv("JPA") +
      "JP,WO2099000005,A5,20990215\r\n";
    const entries: ZipFixtureEntryInput[] = [
      ...minimalJpaEntries({ documentListCsv }),
      {
        fileName: "DOCUMENT/P_P5/CONTENTS1.csv",
        data: fictionalContents1Csv("JPA", "FICTIONAL-P5-CONTENTS-1"),
      },
      {
        fileName: "DOCUMENT/P_P5/CONTENTS2.csv",
        data: fictionalContents2Csv("JPA", "FICTIONAL-P5-CONTENTS-2"),
      },
      {
        fileName: fictionalPrimaryEntryPath("P5"),
        data: buildFictionalAmendmentXml("P5"),
      },
    ];
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.csvResults.map((item) => item.normalizedPath)).toEqual(
      expect.arrayContaining([
        "DOCUMENT/P_P5/CONTENTS1.csv",
        "DOCUMENT/P_P5/CONTENTS2.csv",
      ]),
    );
    expect(
      result.issues.filter(
        (issue) =>
          issue.section === "P_P5" && issue.code.startsWith("contents_"),
      ),
    ).toEqual([]);
    expect(
      result.primaryXmlResults.find(
        (item) => item.normalizedPath === fictionalPrimaryEntryPath("P5"),
      )?.result.kind,
    ).toBe("P5");
  });

  it.each([
    [
      "missing",
      fictionalAbstractCsv("JPA").split("\r\n")[0] + "\r\n",
      "abstract_summary_missing",
    ],
    [
      "duplicate",
      (() => {
        const [metadata, summary] = fictionalAbstractCsv("JPA").split("\r\n");
        return `${metadata}\r\n${summary}\r\n${summary}\r\n`;
      })(),
      "abstract_summary_ambiguous",
    ],
    [
      "unknown",
      (() => {
        const [metadata] = fictionalAbstractCsv("JPA").split("\r\n");
        return (
          `${metadata}\r\n` +
          "FICTIONAL-UNKNOWN-SECTION,FICTIONAL-RANGE-OPAQUE,00001\r\n"
        );
      })(),
      "abstract_summary_ambiguous",
    ],
  ] as const)(
    "reports a %s ABSTRACT section summary",
    async (caseName, abstractCsv, expectedIssue) => {
      const bytes = buildZip({
        entries: minimalJpaEntries({ abstractCsv }),
      }).bytes;
      const result = await parseKohoPackageWithDependencies(packageInput({
        type: "buffer",
        bytes,
      }), {});

      expect(result.status).toBe("review_required");
      expect(issueCodes(result)).toContain(expectedIssue);
      if (caseName === "unknown") {
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            code: "abstract_summary_ambiguous",
            normalizedPath: "ABSTRACT.csv",
            recordNumber: expect.any(Number),
          }),
        );
      }
    },
  );

  it("does not copy failed CSV body text into package issues", async () => {
    const secretCsvBody = "FICTIONAL-SECRET-CSV-BODY";
    const bytes = buildZip({
      entries: minimalJpaEntries({ abstractCsv: secretCsvBody }),
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("failed");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "csv_parse_failed",
        cause: expect.objectContaining({ source: "csv" }),
      }),
    );
    expect(JSON.stringify(result.issues)).not.toContain(secretCsvBody);
  });

  it("does not copy malformed XML body text into package issues", async () => {
    const secretXmlBody = "<FICTIONAL-SECRET-XML-BODY";
    const bytes = buildZip({
      entries: minimalJpaEntries({ xml: secretXmlBody }),
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("failed");
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "primary_xml_parse_failed",
        cause: expect.objectContaining({ source: "xml" }),
      }),
    );
    expect(JSON.stringify(result.issues)).not.toContain(secretXmlBody);
  });

  it("keeps duplicate CONTENTS records and reports an ambiguous match", async () => {
    const record = fictionalContents1Csv("JPA");
    const bytes = buildZip({
      entries: minimalJpaEntries({ contents1Csv: record + record }),
    }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("contents_record_ambiguous");
    const contents = result.csvResults.find(
      (item) => item.normalizedPath === "DOCUMENT/P_A1/CONTENTS1.csv",
    );
    expect(contents?.result.records).toHaveLength(2);
  });

  it("parses a package containing both stored and deflate entries", async () => {
    const entries = minimalJpaEntries().map((entry, index) => ({
      ...entry,
      compressionMethod: index % 2 === 0 ? 0 : 8,
    }));
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("success");
  });

  it("keeps full-publication, amendment, nested, folder, role, and attachment counts separate", async () => {
    const abstractCsv =
      fictionalAbstractCsv("JPA") +
      "補正の掲載（公開特許公報）,FICTIONAL-A5-RANGE,00001\r\n";
    const documentListCsv =
      fictionalDocumentListCsv("JPA") +
      "JP,2099000005,A5,20990115\r\n";
    const a5Path = fictionalPrimaryEntryPath("A5");
    const nestedPath =
      "DOCUMENT/P_A5/999900/999990/2099000005/SEQL/FICTIONAL.xml";
    const entries: ZipFixtureEntryInput[] = [
      ...minimalJpaEntries({ abstractCsv, documentListCsv }),
      {
        fileName: a5Path,
        data: buildFictionalAmendmentXml("A5"),
      },
      {
        fileName: nestedPath,
        data: "<FICTIONAL-NESTED/>",
      },
      {
        fileName: "DOCUMENT/P_A1/999900/999990/2099000001/",
      },
      {
        fileName: "DOCUMENT/P_A1/999900/999990/2099000001/FICTIONAL.png",
        data: "FICTIONAL-IMAGE",
      },
      { fileName: "XSD/FICTIONAL.xsd", data: "<FICTIONAL-SCHEMA/>" },
      { fileName: "OTHER/FICTIONAL.bin", data: "FICTIONAL-OTHER" },
    ];
    const bytes = buildZip({ entries }).bytes;

    const result = await parseKohoPackageWithDependencies(packageInput({
      type: "buffer",
      bytes,
    }), {});

    expect(result.status).toBe("success");
    expect(result.counts).toEqual(
      expect.objectContaining({
        primaryXmlCandidates: 2,
        finalXmlResults: 2,
        confirmedFullPublications: 1,
        confirmedAmendments: 1,
        nestedXmlCandidates: 1,
        documentFolders: 2,
        documentListRecords: 2,
      }),
    );
    expect(result.counts.bySection.P_A1).toEqual(
      expect.objectContaining({
        primaryXmlCandidates: 1,
        finalXmlResults: 1,
        confirmedFullPublications: 1,
        confirmedAmendments: 0,
        documentFolders: 1,
        contents1Records: 1,
        contents2Records: 1,
        attachmentCount: 1,
      }),
    );
    expect(result.counts.bySection.P_A5).toEqual(
      expect.objectContaining({
        primaryXmlCandidates: 1,
        finalXmlResults: 1,
        confirmedFullPublications: 0,
        confirmedAmendments: 1,
        documentFolders: 1,
        attachmentCount: 1,
      }),
    );
    expect(result.counts.roleCounts).toEqual(
      expect.objectContaining({
        csv: 4,
        xml: 3,
        directory: 1,
        image: 1,
        schema: 1,
        other: 1,
      }),
    );
    expect(result.primaryXmlResults.map((item) => item.normalizedPath)).toEqual(
      [fictionalPrimaryEntryPath("A1"), a5Path].sort(),
    );
  });

  it.each([
    ["zip", "maxSourceBytes"],
    ["zip", "maxCentralDirectoryBytes"],
    ["zip", "maxEntries"],
    ["zip", "maxTotalCompressedBytes"],
    ["zip", "maxTotalUncompressedBytes"],
    ["zip", "maxEntryCompressedBytes"],
    ["zip", "maxEntryUncompressedBytes"],
    ["zip", "maxTotalReadUncompressedBytes"],
    ["csv", "maxInputBytes"],
    ["csv", "maxRecords"],
    ["csv", "maxColumnsPerRecord"],
    ["csv", "maxCellCharacters"],
    ["csv", "maxTotalCharacters"],
    ["xml", "maxXmlBytes"],
    ["xml", "maxDepth"],
    ["xml", "maxElements"],
    ["xml", "maxTextBytes"],
  ] as const)(
    "rejects invalid %s.%s before source access",
    async (group, field) => {
      const limits = structuredClone(
        FICTIONAL_PACKAGE_LIMITS,
      ) as KohoPackageLimits;
      (limits[group] as unknown as Record<string, number>)[field] = 0;
      let sourceTouched = false;
      const input = {
        packageType: "JPA",
        limits,
        get source() {
          sourceTouched = true;
          throw new Error("source must not be touched");
        },
      } as unknown as KohoPackageParseInput;

      const result = await parseKohoPackageWithDependencies(input, {});

      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toEqual(["invalid_limits"]);
      expect(sourceTouched).toBe(false);
    },
  );
});
