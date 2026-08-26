import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import { parseKohoCsv, type KohoCsvContractParseResult } from "../koho-csv";
import { buildZip } from "../koho-zip/__fixtures__/zip-builder";
import { KohoZipError, type KohoZipEntry, type KohoZipReader } from "../koho-zip";
import {
  buildFictionalFullPublicationXml,
  fictionalPrimaryEntryPath,
} from "../koho-xml/__fixtures__/fictional-koho";
import { parseKohoXml } from "../koho-xml";
import { parseKohoPackage } from "./index";
import { parseKohoPackageWithDependencies } from "./orchestrator";
import {
  buildMinimalFictionalPackage,
  FICTIONAL_PACKAGE_LIMITS,
  fictionalAbstractCsv,
  fictionalContents1Csv,
  fictionalContents2Csv,
  fictionalDocumentListCsv,
} from "./__fixtures__/fictional-package";
import type {
  KohoPackageLimits,
  KohoPackageParseInput,
  KohoPackageParseResult,
  KohoPackageStatus,
} from "./index";

function issueCodes(result: KohoPackageParseResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function minimalJpaEntries() {
  return [
    { fileName: "ABSTRACT.csv", data: fictionalAbstractCsv("JPA") },
    { fileName: "DOCUMENT_LIST.csv", data: fictionalDocumentListCsv("JPA") },
    { fileName: "DOCUMENT/P_A1/CONTENTS1.csv", data: fictionalContents1Csv("JPA") },
    { fileName: "DOCUMENT/P_A1/CONTENTS2.csv", data: fictionalContents2Csv("JPA") },
    {
      fileName: fictionalPrimaryEntryPath("A1"),
      data: buildFictionalFullPublicationXml("A1"),
    },
  ];
}

function parseBuffer(bytes: Uint8Array, limits = FICTIONAL_PACKAGE_LIMITS) {
  return parseKohoPackage({
    packageType: "JPA",
    source: { type: "buffer", bytes, sourceName: "fictional-package.zip" },
    limits,
  });
}

function fakeEntry(
  id: number,
  normalizedPath: string,
  overrides: Partial<KohoZipEntry> = {},
): KohoZipEntry {
  const basename = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  const role = basename.endsWith(".csv") ? "csv" : basename.endsWith(".xml") ? "xml" : "other";
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

describe("parseKohoPackage public contract", () => {
  it("exports the required package API shape", () => {
    expectTypeOf<KohoPackageStatus>().toEqualTypeOf<
      "success" | "review_required" | "failed"
    >();
    expectTypeOf<KohoPackageLimits["csv"]>().toHaveProperty("maxInputBytes");
    expectTypeOf(parseKohoPackage).returns.resolves.toMatchTypeOf<KohoPackageParseResult>();
  });

  it("parses a minimal fictional JPA package without extracting the archive", async () => {
    const result = await parseBuffer(buildMinimalFictionalPackage("JPA"));

    expect(result.status).toBe("success");
    expect(result.issues).toEqual([]);
    expect(result.zipSummary?.sourceType).toBe("buffer");
    expect(result.csvResults.map((item) => item.result.logicalFile)).toEqual([
      "contents1",
      "contents2",
      "abstract",
      "document_list",
    ].sort());
    expect(result.primaryXmlResults).toHaveLength(1);
    expect(result.primaryXmlResults[0].result.status).toBe("success");
    expect(result.primaryXmlResults[0].result.issues.map((issue) => issue.code)).not.toContain(
      "index_hint_missing",
    );
    expect(result.counts.primaryXmlCandidates).toBe(1);
    expect(result.counts.confirmedFullPublications).toBe(1);
    expect(result.counts.documentListRecords).toBe(1);
    expect(result.counts.bySection.P_A1.contents1Records).toBe(1);
    expect(result.counts.bySection.P_A1.contents2Records).toBe(1);
  });

  it("parses a minimal fictional JPB deflate package and matches leading-zero B publication numbers", async () => {
    const result = await parseKohoPackage({
      packageType: "JPB",
      source: {
        type: "buffer",
        bytes: buildMinimalFictionalPackage("JPB", { compressionMethod: 8 }),
      },
      limits: FICTIONAL_PACKAGE_LIMITS,
    });

    expect(result.status).toBe("success");
    expect(result.issues).toEqual([]);
    expect(result.primaryXmlResults[0].result.status).toBe("success");
    expect(result.counts.bySection.P_B1.confirmedFullPublications).toBe(1);
  });

  it("is deterministic and preserves manifest ID order", async () => {
    const bytes = buildMinimalFictionalPackage("JPA", {
      includeNestedXml: true,
      includeIgnoredEntries: true,
    });
    const first = await parseBuffer(bytes);
    const second = await parseBuffer(bytes);

    expect(first).toEqual(second);
    expect(first.manifest.map((entry) => entry.entryId)).toEqual(
      [...first.manifest.map((entry) => entry.entryId)].sort((a, b) => a - b),
    );
    expect(first.manifest.some((entry) => entry.processing === "counted_nested_xml")).toBe(true);
    expect(
      first.manifest.filter((entry) => ["schema", "image", "other"].includes(entry.role)).every(
        (entry) => entry.processing === "ignored_attachment",
      ),
    ).toBe(true);
    expect(first.counts.nestedXmlCandidates).toBe(1);
  });

  it("supports a fictional temporary file source without returning the local source path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koho-package-fictional-"));
    const filePath = join(directory, "fixture.zip");
    try {
      await writeFile(filePath, buildMinimalFictionalPackage("JPA"));
      const result = await parseKohoPackage({
        packageType: "JPA",
        source: { type: "file", path: filePath },
        limits: FICTIONAL_PACKAGE_LIMITS,
      });

      expect(result.status).toBe("success");
      expect(result.zipSummary?.sourceType).toBe("file");
      expect(result.zipSummary?.sourceName).toBeNull();
      expect(JSON.stringify(result)).not.toContain(filePath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("validation and bounded entry selection", () => {
  it.each([
    ["zip", "maxEntries"],
    ["csv", "maxRecords"],
    ["xml", "maxDepth"],
  ] as const)("rejects invalid %s.%s before touching source", async (group, key) => {
    let sourceTouched = false;
    const invalidLimits = structuredClone(FICTIONAL_PACKAGE_LIMITS) as KohoPackageLimits;
    (invalidLimits[group] as Record<string, number>)[key] = 0;
    const input = {
      packageType: "JPA",
      limits: invalidLimits,
      get source() {
        sourceTouched = true;
        throw new Error("source must not be touched");
      },
    } as unknown as KohoPackageParseInput;

    const result = await parseKohoPackage(input);
    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(["invalid_limits"]);
    expect(result.zipSummary).toBeNull();
    expect(sourceTouched).toBe(false);
  });

  it("rejects non-finite, fractional, negative, and invalid package values before source access", async () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      const limits = structuredClone(FICTIONAL_PACKAGE_LIMITS);
      limits.csv.maxInputBytes = value;
      const result = await parseKohoPackage({
        packageType: "JPA",
        source: { type: "buffer", bytes: new Uint8Array() },
        limits,
      });
      expect(result.status).toBe("failed");
      expect(issueCodes(result)).toEqual(["invalid_limits"]);
    }

    const invalidPackage = await parseKohoPackage({
      packageType: "INVALID" as "JPA",
      source: { type: "buffer", bytes: new Uint8Array() },
      limits: FICTIONAL_PACKAGE_LIMITS,
    });
    expect(invalidPackage.status).toBe("failed");
    expect(issueCodes(invalidPackage)).toEqual(["invalid_limits"]);
  });

  it("fails when a root CSV is missing and does not parse primary XML", async () => {
    const bytes = buildZip({
      entries: minimalJpaEntries().filter((entry) => entry.fileName !== "ABSTRACT.csv"),
    }).bytes;
    const result = await parseBuffer(bytes);

    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toContain("required_csv_missing");
    expect(result.primaryXmlResults).toEqual([]);
    expect(
      result.manifest.find((entry) => entry.pathCandidate === "primary_xml")?.status,
    ).toBe("not_processed");
  });

  it("does not read an unknown CSV body and marks it unclassified", async () => {
    const bytes = buildZip({
      entries: [
        ...minimalJpaEntries(),
        { fileName: "EXTRA/FICTIONAL.csv", data: Uint8Array.from([0xff, 0xff]) },
      ],
    }).bytes;
    const result = await parseBuffer(bytes);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unclassified_csv_entry");
    expect(
      result.manifest.find((entry) => entry.normalizedPath === "EXTRA/FICTIONAL.csv"),
    ).toEqual(expect.objectContaining({ processing: "unclassified", status: "review_required" }));
  });

  it("does not parse nested or unclassified XML bodies", async () => {
    const bytes = buildZip({
      entries: [
        ...minimalJpaEntries(),
        {
          fileName: "DOCUMENT/P_A1/999900/999990/2099000001/NESTED/BROKEN.xml",
          data: "<not-even-closed",
        },
        { fileName: "EXTRA/BROKEN.xml", data: "<not-even-closed" },
      ],
    }).bytes;
    const result = await parseBuffer(bytes);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("unclassified_xml_entry");
    expect(result.primaryXmlResults).toHaveLength(1);
    expect(result.counts.nestedXmlCandidates).toBe(1);
  });
});

describe("cross checks", () => {
  it("reports a DOCUMENT_LIST match miss without inferring JPA A to A1", async () => {
    const bytes = buildMinimalFictionalPackage("JPA", {
      documentListCsv: "JP,FICTIONAL-OTHER,A,20990111\r\n",
    });
    const result = await parseBuffer(bytes);

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("document_list_match_missing");
    expect(issueCodes(result)).toContain("document_list_orphan");
    expect(result.primaryXmlResults[0].result.status).toBe("review_required");
  });

  it("accepts duplicate DOCUMENT_LIST rows only when kind and date reach consensus", async () => {
    const same = "JP,2099000001,A,20990111\r\nJP,20-99000001,A,20990111\r\n";
    const result = await parseBuffer(
      buildMinimalFictionalPackage("JPA", { documentListCsv: same }),
    );

    expect(result.primaryXmlResults[0].result.status).toBe("success");
    expect(issueCodes(result)).not.toContain("document_list_match_ambiguous");
    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("document_list_count_mismatch");
  });

  it("keeps a conflicting duplicate match unconfirmed", async () => {
    const conflicting = "JP,2099000001,A,20990111\r\nJP,2099000001,A5,20990112\r\n";
    const result = await parseBuffer(
      buildMinimalFictionalPackage("JPA", { documentListCsv: conflicting }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("document_list_match_ambiguous");
    expect(issueCodes(result)).toContain("primary_xml_unconfirmed");
  });

  it("reports ABSTRACT count mismatch without interpreting publicationNumberRange", async () => {
    const abstract =
      "JPA,20990111,FICTIONAL-ISSUE-0001,01122\r\n" +
      "公開特許公報（特開）,DO-NOT-EXPAND-2099000001-2099999999,00002\r\n";
    const result = await parseBuffer(
      buildMinimalFictionalPackage("JPA", { abstractCsv: abstract }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("abstract_count_mismatch");
    const abstractResult = result.csvResults.find((item) => item.result.logicalFile === "abstract");
    expect(JSON.stringify(abstractResult)).toContain("DO-NOT-EXPAND-2099000001-2099999999");
  });

  it("reports missing canonical CONTENTS only when a full-publication section is populated", async () => {
    const result = await parseBuffer(
      buildMinimalFictionalPackage("JPA", { includeContents2: false }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("contents_file_missing");
  });

  it("reports missing and orphan CONTENTS publication records", async () => {
    const result = await parseBuffer(
      buildMinimalFictionalPackage("JPA", {
        contents1Csv: fictionalContents1Csv("JPA", "FICTIONAL-ORPHAN"),
      }),
    );

    expect(result.status).toBe("review_required");
    expect(issueCodes(result)).toContain("contents_record_missing");
    expect(issueCodes(result)).toContain("contents_record_orphan");
  });
});

describe("resource closure and safe failure mapping", () => {
  it("closes a reader after root failure and maps close failure without exposing error text", async () => {
    let closed = 0;
    const entries = [fakeEntry(0, "DOCUMENT_LIST.csv")];
    const reader: KohoZipReader = {
      entries,
      summary: {
        sourceType: "buffer",
        sourceName: null,
        sourceSize: 10,
        zip64: false,
        commentLength: 0,
        eocdTailBytesRead: 10,
        centralDirectoryOffset: 0,
        declaredCentralDirectorySize: 0,
        metadataBytesRead: 10,
        targetedMetadataBytesRead: 0,
        declaredEntryCount: 1,
        observedEntryCount: 1,
        totalDeclaredCompressedBytes: 10,
        totalDeclaredUncompressedBytes: 10,
        roleCounts: { directory: 0, xml: 0, csv: 1, schema: 0, image: 0, other: 0 },
        candidateCounts: { primary_xml: 0, nested_xml: 0, none: 1 },
        encryptedEntryCount: 0,
        unsupportedCompressionEntryCount: 0,
      },
      async readEntryBytes() {
        return new TextEncoder().encode(fictionalDocumentListCsv("JPA"));
      },
      async close() {
        closed += 1;
        throw new KohoZipError("source_invalid");
      },
    };

    const result = await parseKohoPackageWithDependencies(
      {
        packageType: "JPA",
        source: { type: "buffer", bytes: new Uint8Array([1]) },
        limits: FICTIONAL_PACKAGE_LIMITS,
      },
      { openZip: async () => reader, parseCsv: (input) => parseKohoCsv(input), parseXml: parseKohoXml },
    );

    expect(closed).toBe(1);
    expect(result.status).toBe("failed");
    expect(issueCodes(result)).toEqual(expect.arrayContaining(["required_csv_missing", "reader_close_failed"]));
    expect(JSON.stringify(result.issues)).not.toContain("source_invalid");
  });

  it("reads selected entries sequentially and at most once", async () => {
    const bytes = buildMinimalFictionalPackage("JPA");
    const baseline = await parseBuffer(bytes);
    expect(baseline.status).toBe("success");

    const readOrder: number[] = [];
    const actualReaderModule = await import("../koho-zip");
    const reader = await actualReaderModule.openKohoZip({
      source: { type: "buffer", bytes },
      limits: FICTIONAL_PACKAGE_LIMITS.zip,
    });
    const wrapped: KohoZipReader = {
      entries: reader.entries,
      summary: reader.summary,
      async readEntryBytes(entryId) {
        readOrder.push(entryId);
        return reader.readEntryBytes(entryId);
      },
      close: () => reader.close(),
    };

    const result = await parseKohoPackageWithDependencies(
      {
        packageType: "JPA",
        source: { type: "buffer", bytes },
        limits: FICTIONAL_PACKAGE_LIMITS,
      },
      { openZip: async () => wrapped },
    );

    expect(result.status).toBe("success");
    expect(new Set(readOrder).size).toBe(readOrder.length);
    expect(readOrder.slice(0, 2)).toEqual([
      wrapped.entries.find((entry) => entry.normalizedPath === "ABSTRACT.csv")!.id,
      wrapped.entries.find((entry) => entry.normalizedPath === "DOCUMENT_LIST.csv")!.id,
    ]);
  });
});
