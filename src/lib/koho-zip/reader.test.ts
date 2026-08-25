import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ZipFile } from "yauzl";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildZip,
  ZIP_FIXTURE_FIELD_OFFSETS,
} from "./__fixtures__/zip-builder";
import {
  openKohoZip,
  type KohoZipErrorCode,
  type KohoZipLimits,
  type KohoZipReader,
} from "./index";

const DEFAULT_LIMITS: KohoZipLimits = Object.freeze({
  maxSourceBytes: 2_000_000,
  maxCentralDirectoryBytes: 2_000_000,
  maxEntries: 100,
  maxTotalCompressedBytes: 2_000_000,
  maxTotalUncompressedBytes: 2_000_000,
  maxEntryCompressedBytes: 1_000_000,
  maxEntryUncompressedBytes: 1_000_000,
  maxTotalReadUncompressedBytes: 2_000_000,
});

const openReaders = new Set<KohoZipReader>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  const readers = [...openReaders];
  const directories = [...temporaryDirectories];
  openReaders.clear();
  temporaryDirectories.clear();
  vi.restoreAllMocks();
  await Promise.allSettled(readers.map((reader) => reader.close()));
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function limits(
  overrides: Partial<KohoZipLimits> = {},
): KohoZipLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

async function openBuffer(
  bytes: Uint8Array,
  configuredLimits: KohoZipLimits = limits(),
): Promise<KohoZipReader> {
  const reader = await openKohoZip({
    source: {
      type: "buffer",
      bytes,
      sourceName: "fictional-fixture.zip",
    },
    limits: configuredLimits,
  });
  openReaders.add(reader);
  return reader;
}

async function expectZipError(
  promise: Promise<unknown>,
  code: KohoZipErrorCode,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "KohoZipError",
    code,
  });
}

function expectBytes(actual: Uint8Array, expected: string): void {
  expect(Buffer.from(actual)).toEqual(Buffer.from(expected, "utf8"));
}

describe("openKohoZip normal reading", () => {
  it("open中はbounded raw tailだけを許可し選択entry streamはread時に開く", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/SELECTED-PAYLOAD.bin",
          data: Buffer.alloc(8_192, 0x53),
        },
        {
          fileName: "FICTIONAL/UNSELECTED-PAYLOAD.bin",
          data: Buffer.alloc(8_192, 0x55),
        },
      ],
    });
    const openReadStream = vi.spyOn(
      ZipFile.prototype,
      "openReadStreamPromise",
    );
    const reader = await openBuffer(fixture.bytes);

    expect(reader.summary.eocdTailBytesRead).toBe(fixture.bytes.byteLength);
    expect(reader.summary.metadataBytesRead).toBe(fixture.bytes.byteLength);
    expect(reader.summary.targetedMetadataBytesRead).toBe(
      fixture.centralDirectorySize,
    );
    expect(openReadStream).not.toHaveBeenCalled();

    expect(await reader.readEntryBytes(0)).toEqual(
      Buffer.alloc(8_192, 0x53),
    );
    expect(openReadStream).toHaveBeenCalledTimes(1);
    expect(openReadStream.mock.calls[0][0].fileName).toBe(
      "FICTIONAL/SELECTED-PAYLOAD.bin",
    );
    expect(reader.summary.metadataBytesRead).toBe(fixture.bytes.byteLength);
    expect(reader.summary.targetedMetadataBytesRead).toBe(
      fixture.centralDirectorySize,
    );
  });

  it("EOCD raw tail scanを65,557 bytesに制限しyauzlではsourceを再走査しない", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/MAX-COMMENT.bin",
          data: Buffer.alloc(256, 0x46),
        },
      ],
      comment: Buffer.alloc(0xffff, 0x43),
    });
    const expectedMetadataBytes =
      65_557 + fixture.centralDirectorySize;

    await expectZipError(
      openBuffer(
        fixture.bytes,
        limits({
          maxCentralDirectoryBytes: expectedMetadataBytes - 1,
        }),
      ),
      "central_directory_too_large",
    );

    const reader = await openBuffer(
      fixture.bytes,
      limits({
        maxCentralDirectoryBytes: expectedMetadataBytes,
      }),
    );

    expect(reader.summary.eocdTailBytesRead).toBe(65_557);
    expect(reader.summary.metadataBytesRead).toBe(expectedMetadataBytes);
    expect(reader.summary.targetedMetadataBytesRead).toBe(
      fixture.centralDirectorySize,
    );
  });

  it("ZIP64の最大commentでもlocatorをtargeted readしentryを展開しない", async () => {
    const fixture = buildZip({
      archiveZip64: true,
      entries: [
        {
          fileName: "FICTIONAL/ZIP64-MAX-COMMENT.bin",
          data: Buffer.alloc(256, 0x5a),
        },
      ],
      comment: Buffer.alloc(0xffff, 0x43),
    });
    const expectedTargetedMetadataBytes =
      fixture.centralDirectorySize + 56 + 20;
    const expectedMetadataBytes =
      65_557 + expectedTargetedMetadataBytes;

    const reader = await openBuffer(
      fixture.bytes,
      limits({ maxCentralDirectoryBytes: expectedMetadataBytes }),
    );

    expect(reader.summary).toMatchObject({
      zip64: true,
      eocdTailBytesRead: 65_557,
      metadataBytesRead: expectedMetadataBytes,
      targetedMetadataBytesRead: expectedTargetedMetadataBytes,
    });
  });

  it("storedとdeflate entryを列挙し、選択したbyte列を返す", async () => {
    const storedName = Buffer.from("FICTIONAL/STORED.txt", "utf8");
    const fixture = buildZip({
      entries: [
        {
          fileName: storedName,
          data: "fictional-stored-body",
        },
        {
          fileName: "FICTIONAL/DEFLATED.xml",
          data: "<fictional>deflated</fictional>",
          compressionMethod: 8,
        },
      ],
      comment: "fictional-package",
    });

    const reader = await openBuffer(fixture.bytes);

    expect(reader.entries).toHaveLength(2);
    expect(reader.entries.map((entry) => entry.compressionMethod)).toEqual([
      0, 8,
    ]);
    expect(reader.entries[0].rawFileNameBase64).toBe(
      storedName.toString("base64"),
    );
    expect(reader.entries.every((entry) => entry.canRead)).toBe(true);
    expect(reader.summary).toMatchObject({
      sourceType: "buffer",
      sourceName: "fictional-fixture.zip",
      sourceSize: fixture.bytes.byteLength,
      commentLength: Buffer.byteLength("fictional-package"),
      eocdTailBytesRead: fixture.bytes.byteLength,
      declaredEntryCount: 2,
      observedEntryCount: 2,
      totalDeclaredCompressedBytes:
        fixture.entries[0].actualCompressedSize +
        fixture.entries[1].actualCompressedSize,
      totalDeclaredUncompressedBytes:
        fixture.entries[0].actualUncompressedSize +
        fixture.entries[1].actualUncompressedSize,
    });

    expectBytes(
      await reader.readEntryBytes(reader.entries[0].id),
      "fictional-stored-body",
    );
    expectBytes(
      await reader.readEntryBytes(reader.entries[1].id),
      "<fictional>deflated</fictional>",
    );
  });

  it("directory有無に依存せずroleとXML candidateを決定的に分類する", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "DOCUMENT/" },
        {
          fileName:
            "DOCUMENT/P_A1/FICTIONAL-BUCKET-100/FICTIONAL-BUCKET-10/FICTIONAL-DOC-001/FICTIONAL-DOC-001.xml",
          data: "<fictional-primary/>",
        },
        {
          fileName:
            "DOCUMENT/P_A1/FICTIONAL-BUCKET-100/FICTIONAL-BUCKET-10/FICTIONAL-DOC-001/SEQL/FICTIONAL-SEQUENCE.xml",
          data: "<fictional-nested/>",
        },
        { fileName: "INDEX/FICTIONAL.csv", data: "fictional,value\n" },
        { fileName: "XSD/FICTIONAL.xsd", data: "<fictional-schema/>" },
        { fileName: "IMAGE/FICTIONAL.tif", data: "fictional-image" },
        { fileName: "OTHER/FICTIONAL.bin", data: "fictional-other" },
      ],
    });

    const reader = await openBuffer(fixture.bytes);

    expect(reader.entries.map((entry) => entry.role)).toEqual([
      "directory",
      "xml",
      "xml",
      "csv",
      "schema",
      "image",
      "other",
    ]);
    expect(reader.entries.map((entry) => entry.pathCandidate)).toEqual([
      "none",
      "primary_xml",
      "nested_xml",
      "none",
      "none",
      "none",
      "none",
    ]);
    expect(reader.entries[0]).toMatchObject({
      normalizedPath: "DOCUMENT",
      isDirectory: true,
      canRead: false,
    });
    expect(reader.summary.roleCounts).toEqual({
      directory: 1,
      xml: 2,
      csv: 1,
      schema: 1,
      image: 1,
      other: 1,
    });
    expect(reader.summary.candidateCounts).toEqual({
      primary_xml: 1,
      nested_xml: 1,
      none: 5,
    });

    const withoutDirectory = buildZip({
      entries: [
        {
          fileName: "MISSING-EXPLICIT-DIRECTORY/FICTIONAL.txt",
          data: "fictional-body",
        },
      ],
    });
    const secondReader = await openBuffer(withoutDirectory.bytes);
    expect(secondReader.entries).toHaveLength(1);
    expect(secondReader.entries[0].role).toBe("other");
  });

  it("壊れた非選択entryのlocal headerを開かず正常entryだけを読む", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/SELECTED.txt",
          data: "fictional-selected-body",
        },
        {
          fileName: "FICTIONAL/UNSELECTED.txt",
          data: "fictional-unselected-body",
        },
      ],
    });
    const mutatedBytes = Buffer.from(fixture.bytes);
    mutatedBytes.writeUInt32LE(
      0,
      fixture.entries[1].localHeaderOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.local.signature,
    );

    const reader = await openBuffer(mutatedBytes);

    expect(reader.entries).toHaveLength(2);
    expectBytes(
      await reader.readEntryBytes(reader.entries[0].id),
      "fictional-selected-body",
    );
  });

  it("buffer subarrayの範囲だけをsourceとし、open後の同長mutationを読取へ反映する", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/MUTABLE.txt",
          data: "AAAA",
        },
      ],
    });
    const prefixLength = 11;
    const backing = Buffer.alloc(
      prefixLength + fixture.bytes.byteLength + 13,
      0xa5,
    );
    fixture.bytes.copy(backing, prefixLength);
    const sourceView = new Uint8Array(
      backing.buffer,
      backing.byteOffset + prefixLength,
      fixture.bytes.byteLength,
    );

    const reader = await openBuffer(sourceView);
    backing[prefixLength + fixture.entries[0].dataOffset] =
      "B".charCodeAt(0);

    expect(reader.summary.sourceSize).toBe(fixture.bytes.byteLength);
    expectBytes(await reader.readEntryBytes(0), "BAAA");
  });

  it("file sourceをrenameしてdecoyを置いてもopen済みの同一fdから読む", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/FILE-SOURCE.txt",
          data: "fictional-file-body",
        },
      ],
    });
    const directory = await mkdtemp(join(tmpdir(), "koho-zip-fictional-"));
    temporaryDirectories.add(directory);
    const activePath = join(directory, "active.zip");
    const renamedPath = join(directory, "opened.zip");
    await writeFile(activePath, fixture.bytes);

    const reader = await openKohoZip({
      source: { type: "file", path: activePath },
      limits: limits(),
    });
    openReaders.add(reader);
    await rename(activePath, renamedPath);
    await writeFile(activePath, Buffer.from("fictional-decoy-not-a-zip"));

    expect(reader.summary).toMatchObject({
      sourceType: "file",
      sourceName: null,
      sourceSize: fixture.bytes.byteLength,
    });
    expect(JSON.stringify(reader.summary)).not.toContain(directory);
    expectBytes(await reader.readEntryBytes(0), "fictional-file-body");
  });
});

describe("KohoZipReader lifecycle and read policy", () => {
  it("closeはidempotentで、close後の列挙とreadをreader_closedにする", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "FICTIONAL/CLOSE.txt", data: "fictional-close" },
      ],
    });
    const reader = await openBuffer(fixture.bytes);

    await reader.close();
    await reader.close();

    expect(() => reader.entries).toThrowError(
      expect.objectContaining({ code: "reader_closed" }),
    );
    expect(() => reader.summary).toThrowError(
      expect.objectContaining({ code: "reader_closed" }),
    );
    await expectZipError(reader.readEntryBytes(0), "reader_closed");
  });

  it("同時readを拒否し、先行read完了後にlockを解放する", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "FICTIONAL/FIRST.txt", data: "fictional-first" },
        { fileName: "FICTIONAL/SECOND.txt", data: "fictional-second" },
      ],
    });
    const reader = await openBuffer(fixture.bytes);

    const firstRead = reader.readEntryBytes(0);
    const concurrentRead = reader.readEntryBytes(1);

    await expectZipError(concurrentRead, "concurrent_read_forbidden");
    expectBytes(await firstRead, "fictional-first");
    expectBytes(await reader.readEntryBytes(1), "fictional-second");
  });

  it("reader lifetimeの累積uncompressed read上限を2回目で強制する", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "FICTIONAL/READ-ONE.bin", data: "1234" },
        { fileName: "FICTIONAL/READ-TWO.bin", data: "5678" },
      ],
    });
    const reader = await openBuffer(
      fixture.bytes,
      limits({ maxTotalReadUncompressedBytes: 6 }),
    );

    expectBytes(await reader.readEntryBytes(0), "1234");
    await expectZipError(reader.readEntryBytes(1), "entry_read_limit");
  });

  it("traditional encryptionをmetadataに残しentry bodyを読まない", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/ENCRYPTED.bin",
          data: "fictional-encrypted-placeholder",
          compressionMethod: 8,
          flags: 0x0801,
        },
      ],
    });
    const reader = await openBuffer(fixture.bytes);

    expect(reader.entries[0]).toMatchObject({
      encrypted: true,
      canRead: false,
      issues: [
        expect.objectContaining({ code: "encrypted_entry" }),
      ],
    });
    expect(reader.summary.encryptedEntryCount).toBe(1);
    await expectZipError(reader.readEntryBytes(0), "encrypted_entry");
  });

  it("stored/deflate以外のmethodをmetadataに残しreadを拒否する", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/UNSUPPORTED.bin",
          data: "fictional-unsupported-placeholder",
          compressionMethod: 12,
        },
      ],
    });
    const reader = await openBuffer(fixture.bytes);

    expect(reader.entries[0]).toMatchObject({
      compressionMethod: 12,
      canRead: false,
      issues: [
        expect.objectContaining({ code: "unsupported_compression" }),
      ],
    });
    expect(reader.summary.unsupportedCompressionEntryCount).toBe(1);
    await expectZipError(reader.readEntryBytes(0), "unsupported_compression");
  });
});
