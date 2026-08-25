import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildZip,
  calculateCrc32,
  ZIP_FIXTURE_FIELD_OFFSETS,
  type BuiltZipFixture,
} from "./__fixtures__/zip-builder";
import { KohoZipError } from "./errors";
import { openKohoZip } from "./reader";
import type { KohoZipLimits, KohoZipReader } from "./types";

const DEFAULT_LIMITS: KohoZipLimits = {
  maxSourceBytes: 2_000_000,
  maxCentralDirectoryBytes: 2_000_000,
  maxEntries: 100,
  maxTotalCompressedBytes: 2_000_000,
  maxTotalUncompressedBytes: 2_000_000,
  maxEntryCompressedBytes: 2_000_000,
  maxEntryUncompressedBytes: 2_000_000,
  maxTotalReadUncompressedBytes: 2_000_000,
};

const openReaders = new Set<KohoZipReader>();

afterEach(async () => {
  await Promise.all([...openReaders].map((reader) => reader.close()));
  openReaders.clear();
});

describe("openKohoZip metadata and resource limits", () => {
  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, 2 ** 53])(
    "rejects invalid limit %s before accessing the source",
    async (invalidLimit) => {
      const sourceGetter = vi.fn(() => ({
        type: "buffer" as const,
        bytes: buildZip({ entries: [] }).bytes,
      }));
      const input = Object.defineProperty(
        {
          limits: limits({ maxEntries: invalidLimit }),
        },
        "source",
        { get: sourceGetter },
      );

      await expectCode(
        openKohoZip(
          input as unknown as Parameters<typeof openKohoZip>[0],
        ),
        "invalid_limits",
      );
      expect(sourceGetter).not.toHaveBeenCalled();
    },
  );

  it("sanitizes throwing input getters into phase-specific typed errors", async () => {
    const marker = "FICTIONAL_GETTER_MARKER";
    const injectedLimitError = new KohoZipError("invalid_limits");
    injectedLimitError.message = marker;
    const limitsInput = Object.defineProperty({}, "limits", {
      get() {
        throw injectedLimitError;
      },
    });
    const limitError = await expectCode(
      openKohoZip(
        limitsInput as unknown as Parameters<typeof openKohoZip>[0],
      ),
      "invalid_limits",
    );
    expect(limitError.message).not.toContain(marker);

    const injectedSourceError = new KohoZipError("source_invalid");
    injectedSourceError.message = marker;
    const sourceInput = Object.defineProperty(
      { limits: DEFAULT_LIMITS },
      "source",
      {
        get() {
          throw injectedSourceError;
        },
      },
    );
    const sourceError = await expectCode(
      openKohoZip(
        sourceInput as unknown as Parameters<typeof openKohoZip>[0],
      ),
      "source_invalid",
    );
    expect(sourceError.message).not.toContain(marker);
  });

  it("rejects an empty source and enforces the source-size boundary", async () => {
    await expectCode(
      openKohoZip({
        source: { type: "buffer", bytes: new Uint8Array() },
        limits: DEFAULT_LIMITS,
      }),
      "source_invalid",
    );

    const fixture = buildZip({
      entries: [{ fileName: "FICTIONAL.txt", data: "bounded" }],
    });
    await expectCode(
      openFixture(fixture, { maxSourceBytes: fixture.bytes.byteLength - 1 }),
      "source_too_large",
    );
    const reader = await openFixture(fixture, {
      maxSourceBytes: fixture.bytes.byteLength,
    });
    expect(reader.summary.sourceSize).toBe(fixture.bytes.byteLength);

    class StatefulByteLength extends Uint8Array {
      reads = 0;

      override get byteLength(): number {
        this.reads += 1;
        return this.reads === 1 ? 1 : fixture.bytes.byteLength;
      }
    }
    const hostileBytes = new StatefulByteLength(fixture.bytes.byteLength);
    hostileBytes.set(fixture.bytes);
    await expectCode(
      openKohoZip({
        source: { type: "buffer", bytes: hostileBytes },
        limits: limits({ maxSourceBytes: 1 }),
      }),
      "source_too_large",
    );
    expect(hostileBytes.reads).toBe(0);
  });

  it("snapshots mutable limit and source descriptors before asynchronous work", async () => {
    const fixture = buildZip({
      entries: [{ fileName: "FICTIONAL.txt", data: "snapshot" }],
    });
    const mutableLimits = limits({ maxSourceBytes: fixture.bytes.byteLength });
    const mutableSource: {
      type: "buffer";
      bytes: Uint8Array;
      sourceName?: string;
    } = {
      type: "buffer",
      bytes: fixture.bytes,
      sourceName: "FICTIONAL.zip",
    };

    const opening = openKohoZip({
      source: mutableSource,
      limits: mutableLimits,
    });
    mutableLimits.maxSourceBytes = 1;
    mutableSource.bytes = new Uint8Array();
    mutableSource.sourceName = "CHANGED.zip";

    const reader = await opening;
    openReaders.add(reader);
    expect(reader.summary.sourceName).toBe("FICTIONAL.zip");
    expect(reader.summary.sourceSize).toBe(fixture.bytes.byteLength);
  });

  it("enforces declared and actually-read central-directory limits", async () => {
    const emptyFixture = buildZip({ entries: [] });
    await expectCode(
      openFixture(emptyFixture, { maxCentralDirectoryBytes: 21 }),
      "central_directory_too_large",
    );

    const longNameFixture = buildZip({
      entries: [{ fileName: "A".repeat(0xffff), data: "" }],
    });
    expect(longNameFixture.centralDirectorySize).toBeGreaterThan(0xffff);
    await expectCode(
      openFixture(longNameFixture, {
        maxCentralDirectoryBytes:
          longNameFixture.centralDirectorySize - 1,
      }),
      "central_directory_too_large",
    );

    const tailFixture = buildZip({
      archiveZip64: true,
      entries: [
        {
          fileName: "FICTIONAL.bin",
          data: Buffer.alloc(70_000, 0x46),
        },
      ],
    });
    const actualMetadataBytes = 65_557;
    await expectCode(
      openFixture(tailFixture, {
        maxCentralDirectoryBytes: actualMetadataBytes - 1,
      }),
      "central_directory_too_large",
    );
    const reader = await openFixture(tailFixture, {
      maxCentralDirectoryBytes: actualMetadataBytes,
    });
    expect(reader.summary.metadataBytesRead).toBe(actualMetadataBytes);
    expect(reader.summary.eocdTailBytesRead).toBe(65_557);
    expect(reader.summary.targetedMetadataBytesRead).toBe(
      tailFixture.centralDirectorySize + 56,
    );
  });

  it("counts overlapping metadata reads only once", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "FOLDER/", data: "" },
        { fileName: "FOLDER/FICTIONAL.xml", data: "metadata only" },
      ],
    });
    const reader = await openFixture(fixture, {
      maxCentralDirectoryBytes: fixture.bytes.byteLength,
    });

    expect(reader.summary.metadataBytesRead).toBe(fixture.bytes.byteLength);
    expect(reader.summary.targetedMetadataBytesRead).toBe(
      fixture.centralDirectorySize,
    );
    expect(reader.summary.eocdTailBytesRead).toBe(fixture.bytes.byteLength);
    expect(reader.summary.declaredCentralDirectorySize).toBe(
      fixture.centralDirectorySize,
    );
  });

  it("enforces declared and observed entry-count limits independently", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "A.txt", data: "a" },
        { fileName: "B.txt", data: "b" },
      ],
    });
    await expectCode(
      openFixture(fixture, { maxEntries: 1 }),
      "entry_count_limit",
    );

    const underDeclared = cloneFixtureBytes(fixture);
    underDeclared.writeUInt16LE(
      1,
      fixture.eocdOffset + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entriesOnDisk,
    );
    underDeclared.writeUInt16LE(
      1,
      fixture.eocdOffset + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entryCount,
    );
    await expectCode(
      openBytes(underDeclared, { maxEntries: 1 }),
      "entry_count_limit",
    );
    const malformedSecondHeader = Buffer.from(underDeclared);
    malformedSecondHeader.writeUInt16LE(
      0xffff,
      fixture.entries[1].centralHeaderOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.central.fileNameLength,
    );
    await expectCode(
      openBytes(malformedSecondHeader, { maxEntries: 1 }),
      "invalid_zip",
    );
    await expectCode(
      openBytes(underDeclared, { maxEntries: 2 }),
      "invalid_zip",
    );
  });

  it("enforces per-entry and cumulative declared size limits", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "A.txt", data: "four" },
        { fileName: "B.txt", data: "five!" },
      ],
    });

    await expectCode(
      openFixture(fixture, { maxEntryCompressedBytes: 4 }),
      "entry_compressed_limit",
    );
    await expectCode(
      openFixture(fixture, { maxEntryUncompressedBytes: 4 }),
      "entry_uncompressed_limit",
    );
    await expectCode(
      openFixture(fixture, { maxTotalCompressedBytes: 8 }),
      "total_compressed_limit",
    );
    await expectCode(
      openFixture(fixture, { maxTotalUncompressedBytes: 8 }),
      "total_uncompressed_limit",
    );

    const reader = await openFixture(fixture, {
      maxEntryCompressedBytes: 5,
      maxEntryUncompressedBytes: 5,
      maxTotalCompressedBytes: 9,
      maxTotalUncompressedBytes: 9,
    });
    expect(reader.summary.totalDeclaredUncompressedBytes).toBe(9);
  });

  it("stops central-directory processing as soon as a size limit is known", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "A.txt", data: "oversized" },
        { fileName: "B.txt", data: "unreachable" },
      ],
    });
    const bytes = cloneFixtureBytes(fixture);
    bytes.writeUInt32LE(0, fixture.entries[1].centralHeaderOffset);

    await expectCode(
      openBytes(bytes, { maxEntryUncompressedBytes: 4 }),
      "entry_uncompressed_limit",
    );
  });

  it("stops an expanding selected entry at the measured read limit", async () => {
    const payload = "X".repeat(100);
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL.txt",
          data: payload,
          compressionMethod: 8,
          localUncompressedSize: 1,
          centralUncompressedSize: 1,
        },
      ],
    });
    const reader = await openFixture(fixture, {
      maxEntryUncompressedBytes: 50,
      maxTotalReadUncompressedBytes: 50,
    });

    await expectCode(reader.readEntryBytes(0), "entry_read_limit");
    await expectCode(reader.readEntryBytes(0), "entry_read_limit");
  });

  it("does not repeatedly expand a declared-empty entry after lifetime exhaustion", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL.txt",
          data: "X",
          compressionMethod: 8,
          localUncompressedSize: 0,
          centralUncompressedSize: 0,
        },
      ],
    });
    const reader = await openFixture(fixture, {
      maxEntryUncompressedBytes: 1,
      maxTotalReadUncompressedBytes: 1,
    });

    await expectCode(reader.readEntryBytes(0), "entry_size_mismatch");
    await expectCode(reader.readEntryBytes(0), "entry_read_limit");
  });
});

describe("openKohoZip malformed and ZIP64 metadata", () => {
  it("opens valid archive-level ZIP64 and rejects unsafe ZIP64 integers", async () => {
    const fixture = buildZip({
      archiveZip64: true,
      entries: [{ fileName: "FICTIONAL.txt", data: "zip64" }],
    });
    const reader = await openFixture(fixture);
    expect(reader.summary.zip64).toBe(true);
    expect(reader.summary.eocdTailBytesRead).toBe(
      fixture.bytes.byteLength,
    );

    const unsafe = cloneFixtureBytes(fixture);
    expect(fixture.zip64EocdOffset).not.toBeNull();
    unsafe.writeBigUInt64LE(
      BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
      fixture.zip64EocdOffset! +
        ZIP_FIXTURE_FIELD_OFFSETS.zip64Eocd.entryCount,
    );
    await expectCode(openBytes(unsafe), "zip64_value_unsafe");
  });

  it("does not decode a ZIP64 entry until readEntryBytes is called", async () => {
    const fixture = buildZip({
      archiveZip64: true,
      entries: [
        {
          fileName: "FICTIONAL/ZIP64-DECODE.xml",
          data: "fictional-zip64-body",
          compressionMethod: 8,
          compressedBytes: Buffer.from([0xff]),
        },
      ],
    });

    const reader = await openFixture(fixture);
    expect(reader.summary.zip64).toBe(true);
    await expectCode(reader.readEntryBytes(0), "invalid_zip");
  });

  it("does not mistake an exact classic maximum entry size for missing ZIP64 metadata", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL.bin",
          data: "x",
          centralCompressedSize: 0xffffffff,
          centralUncompressedSize: 0xffffffff,
        },
      ],
    });
    const reader = await openFixture(fixture, {
      maxEntryCompressedBytes: 5_000_000_000,
      maxEntryUncompressedBytes: 5_000_000_000,
      maxTotalCompressedBytes: 5_000_000_000,
      maxTotalUncompressedBytes: 5_000_000_000,
    });
    expect(reader.entries[0]).toMatchObject({
      compressedSize: 0xffffffff,
      uncompressedSize: 0xffffffff,
    });
  });

  it("rejects truncated metadata and ignores structurally invalid EOCD lookalikes", async () => {
    const fixture = buildZip({
      entries: [{ fileName: "FICTIONAL.txt", data: "metadata" }],
    });
    await expectCode(
      openBytes(fixture.bytes.subarray(0, fixture.bytes.byteLength - 1)),
      "invalid_zip",
    );

    const badCentralSignature = cloneFixtureBytes(fixture);
    badCentralSignature.writeUInt32LE(0, fixture.centralDirectoryOffset);
    await expectCode(openBytes(badCentralSignature), "invalid_zip");

    const falseEocd = Buffer.alloc(22);
    falseEocd.writeUInt32LE(0x06054b50, 0);
    falseEocd.writeUInt16LE(DEFAULT_LIMITS.maxEntries + 1, 8);
    falseEocd.writeUInt16LE(DEFAULT_LIMITS.maxEntries + 1, 10);
    const withInvalidCandidate = buildZip({
      entries: [],
      comment: falseEocd,
    });
    const reader = await openFixture(withInvalidCandidate);
    expect(reader.summary.commentLength).toBe(falseEocd.byteLength);
  });

  it("excludes a decoy whose central record crosses its EOCD boundary", async () => {
    const comment = Buffer.alloc(100);
    const centralOffset = 22;
    const decoyOffset = 72;
    comment.writeUInt32LE(0x02014b50, 0);
    comment.writeUInt16LE(14, ZIP_FIXTURE_FIELD_OFFSETS.central.fileNameLength);
    comment.writeUInt16LE(1, ZIP_FIXTURE_FIELD_OFFSETS.central.diskStart);
    const decoyInComment = decoyOffset - centralOffset;
    comment.writeUInt32LE(0x06054b50, decoyInComment);
    comment.writeUInt16LE(
      1,
      decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entriesOnDisk,
    );
    comment.writeUInt16LE(
      1,
      decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entryCount,
    );
    comment.writeUInt32LE(
      decoyOffset - centralOffset,
      decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectorySize,
    );
    comment.writeUInt32LE(
      centralOffset,
      decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectoryOffset,
    );
    comment.writeUInt16LE(
      comment.byteLength - decoyInComment - 22,
      decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.commentLength,
    );
    const fixture = buildZip({ entries: [], comment });

    const reader = await openFixture(fixture);
    expect(reader.entries).toHaveLength(0);
    expect(reader.summary.commentLength).toBe(comment.byteLength);
  });

  it("bounds aggregate validation work across many invalid EOCD decoys", async () => {
    const decoyCount = 24;
    const fileNameLength = decoyCount * 22 + 10;
    const comment = Buffer.alloc(46 + fileNameLength);
    comment.writeUInt32LE(0x02014b50, 0);
    comment.writeUInt16LE(
      fileNameLength,
      ZIP_FIXTURE_FIELD_OFFSETS.central.fileNameLength,
    );
    const sourceSize = 22 + comment.byteLength;
    for (let index = 0; index < decoyCount; index += 1) {
      const decoyInComment = 46 + index * 22;
      const decoyOffset = 22 + decoyInComment;
      comment.writeUInt32LE(0x06054b50, decoyInComment);
      comment.writeUInt16LE(
        1,
        decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entriesOnDisk,
      );
      comment.writeUInt16LE(
        1,
        decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.entryCount,
      );
      comment.writeUInt32LE(
        decoyOffset - 22,
        decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectorySize,
      );
      comment.writeUInt32LE(
        22,
        decoyInComment +
          ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectoryOffset,
      );
      comment.writeUInt16LE(
        sourceSize - decoyOffset - 22,
        decoyInComment + ZIP_FIXTURE_FIELD_OFFSETS.eocd.commentLength,
      );
    }
    const fixture = buildZip({ entries: [], comment });

    await expectCode(
      openFixture(fixture, {
        maxCentralDirectoryBytes: fixture.bytes.byteLength,
      }),
      "ambiguous_eocd",
    );
  });

  it("rejects multiple structurally valid EOCD interpretations", async () => {
    const secondEocd = Buffer.alloc(22);
    secondEocd.writeUInt32LE(0x06054b50, 0);
    secondEocd.writeUInt32LE(22, 16);
    const ambiguous = buildZip({ entries: [], comment: secondEocd });

    await expectCode(openFixture(ambiguous), "ambiguous_eocd");
  });

  it("fails closed when another structurally plausible EOCD hits a policy limit", async () => {
    const inner = buildZip({
      entries: [
        { fileName: "FICTIONAL/INNER-A.txt", data: "A" },
        { fileName: "FICTIONAL/INNER-B.txt", data: "B" },
      ],
    });
    const shiftedInner = Buffer.from(inner.bytes);
    const outerEocdSize = 22;
    for (const entry of inner.entries) {
      const relativeOffsetField =
        entry.centralHeaderOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.central.relativeLocalHeaderOffset;
      shiftedInner.writeUInt32LE(
        shiftedInner.readUInt32LE(relativeOffsetField) + outerEocdSize,
        relativeOffsetField,
      );
    }
    shiftedInner.writeUInt32LE(
      inner.centralDirectoryOffset + outerEocdSize,
      inner.eocdOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectoryOffset,
    );
    const fixture = buildZip({ entries: [], comment: shiftedInner });

    await expectCode(
      openFixture(fixture, { maxEntries: 1 }),
      "ambiguous_eocd",
    );
  });

  it("rejects multi-disk metadata with a stable code", async () => {
    const fixture = buildZip({
      entries: [{ fileName: "FICTIONAL.txt", data: "single disk" }],
    });
    const bytes = cloneFixtureBytes(fixture);
    bytes.writeUInt16LE(
      1,
      fixture.eocdOffset + ZIP_FIXTURE_FIELD_OFFSETS.eocd.diskNumber,
    );
    bytes.writeUInt16LE(
      1,
      fixture.eocdOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.eocd.centralDirectoryDisk,
    );

    await expectCode(openBytes(bytes), "multi_disk_unsupported");
  });
});

describe("openKohoZip package safety", () => {
  it("retains strong-encryption metadata without opening the entry body", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL/STRONG-ENCRYPTED.bin",
          data: "X",
          compressedBytes: Buffer.alloc(20, 0xa5),
          compressionMethod: 0,
          flags: 0x0841,
        },
      ],
    });
    const reader = await openFixture(fixture);

    expect(reader.entries[0]).toMatchObject({
      encrypted: true,
      compressionMethod: 0,
      compressedSize: 20,
      uncompressedSize: 1,
      canRead: false,
      issues: [expect.objectContaining({ code: "encrypted_entry" })],
    });
    expect(reader.summary.encryptedEntryCount).toBe(1);
    await expectCode(reader.readEntryBytes(0), "encrypted_entry");
  });

  it("rejects an unsafe raw path hidden by a safe Unicode-path extra field", async () => {
    const unsafeRawName = Buffer.from("../HIDDEN.txt", "ascii");
    const fixture = buildZip({
      entries: [
        {
          fileName: unsafeRawName,
          data: "fictional",
          flags: 0,
          centralExtraFields: unicodePathExtra(
            unsafeRawName,
            "SAFE/FICTIONAL.txt",
          ),
        },
      ],
    });

    await expectCode(openFixture(fixture), "unsafe_entry_path");
  });

  it("rejects unsafe and duplicate normalized entry paths", async () => {
    await expectCode(
      openFixture(
        buildZip({
          entries: [{ fileName: "../FICTIONAL.txt", data: "unsafe" }],
        }),
      ),
      "unsafe_entry_path",
    );

    await expectCode(
      openFixture(
        buildZip({
          entries: [
            { fileName: "FOLDER/FICTIONAL.xml", data: "first" },
            { fileName: "FOLDER\\FICTIONAL.xml", data: "second" },
          ],
        }),
      ),
      "duplicate_entry_path",
    );
  });

  it("rejects directory entries with non-zero declared data", async () => {
    await expectCode(
      openFixture(
        buildZip({
          entries: [{ fileName: "FOLDER/", data: "not a directory body" }],
        }),
      ),
      "entry_size_mismatch",
    );
  });

  it("maps selected-entry size mismatch to a stable code", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL.txt",
          data: "short",
          compressionMethod: 8,
          localUncompressedSize: 6,
          centralUncompressedSize: 6,
        },
      ],
    });
    const reader = await openFixture(fixture);
    await expectCode(reader.readEntryBytes(0), "entry_size_mismatch");
  });

  it("rejects local-header size declarations that disagree with the central entry", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL-LOCAL-SIZE.txt",
          data: "abc",
          localCompressedSize: 1,
          localUncompressedSize: 2,
        },
      ],
    });
    const reader = await openFixture(fixture);

    await expectCode(reader.readEntryBytes(0), "entry_size_mismatch");
  });

  it("accepts data-descriptor entries without trusting local size fields", async () => {
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL-DESCRIPTOR.txt",
          data: "descriptor",
          flags: 0x0808,
          localCompressedSize: 0,
          localUncompressedSize: 0,
        },
      ],
    });
    const bytes = cloneFixtureBytes(fixture);
    bytes.writeUInt32LE(
      0,
      fixture.entries[0].localHeaderOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.local.crc32,
    );
    const reader = await openBytes(bytes);

    expect(Buffer.from(await reader.readEntryBytes(0)).toString("utf8")).toBe(
      "descriptor",
    );
  });

  it("accepts selected local ZIP64 size fields that match central metadata", async () => {
    const zip64Sizes = Buffer.alloc(20);
    zip64Sizes.writeUInt16LE(0x0001, 0);
    zip64Sizes.writeUInt16LE(16, 2);
    zip64Sizes.writeBigUInt64LE(BigInt(3), 4);
    zip64Sizes.writeBigUInt64LE(BigInt(3), 12);
    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL-LOCAL-ZIP64.txt",
          data: "zip",
          localExtraFields: zip64Sizes,
          localCompressedSize: 0xffffffff,
          localUncompressedSize: 0xffffffff,
        },
      ],
    });
    const reader = await openFixture(fixture);

    expect(Buffer.from(await reader.readEntryBytes(0)).toString("utf8")).toBe(
      "zip",
    );
  });

  it("rejects duplicate local-header aliases before a selected read", async () => {
    const fixture = buildZip({
      entries: [
        { fileName: "A.txt", data: "a" },
        { fileName: "B.txt", data: "b" },
      ],
    });
    const bytes = cloneFixtureBytes(fixture);
    bytes.writeUInt32LE(
      fixture.entries[0].localHeaderOffset,
      fixture.entries[1].centralHeaderOffset +
        ZIP_FIXTURE_FIELD_OFFSETS.central.relativeLocalHeaderOffset,
    );

    await expectCode(openBytes(bytes), "invalid_zip");
  });

  it("does not expose source paths, names, or entry bodies in public errors", async () => {
    const marker = "FICTIONAL_PRIVATE_MARKER_DO_NOT_LEAK";
    const directory = await mkdtemp(join(tmpdir(), "koho-zip-private-"));
    const secretPath = join(directory, `${marker}.zip`);
    try {
      await writeFile(secretPath, Buffer.from(marker));
      const error = await expectCode(
        openKohoZip({
          source: { type: "file", path: secretPath },
          limits: DEFAULT_LIMITS,
        }),
        "invalid_zip",
      );
      expect(error.message).not.toContain(marker);
      expect(error.message).not.toContain(secretPath);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    const fixture = buildZip({
      entries: [
        {
          fileName: "FICTIONAL.txt",
          data: marker,
          compressionMethod: 8,
          compressedBytes: Buffer.from([0xff]),
        },
      ],
    });
    const reader = await openKohoZip({
      source: {
        type: "buffer",
        bytes: fixture.bytes,
        sourceName: marker,
      },
      limits: DEFAULT_LIMITS,
    });
    openReaders.add(reader);
    const error = await expectCode(reader.readEntryBytes(0), "invalid_zip");
    expect(error.message).not.toContain(marker);
  });

  it("normalizes a source-thrown typed error before exposing it", async () => {
    const marker = "FICTIONAL_MUTATED_ERROR_MESSAGE";
    class ThrowingByteLength extends Uint8Array {
      override get byteLength(): number {
        const error = new KohoZipError("source_invalid");
        error.message = marker;
        throw error;
      }
    }

    const error = await expectCode(
      openKohoZip({
        source: { type: "buffer", bytes: new ThrowingByteLength(0) },
        limits: DEFAULT_LIMITS,
      }),
      "source_invalid",
    );
    expect(error.message).toBe("ZIP source is invalid or unavailable");
    expect(error.message).not.toContain(marker);
  });

  it("maps hostile buffer type checks to source_invalid", async () => {
    const marker = "FICTIONAL_PROXY_MARKER";
    const bytes = new Proxy(new Uint8Array(1), {
      getPrototypeOf() {
        throw new Error(`encrypted ${marker}`);
      },
    });

    const error = await expectCode(
      openKohoZip({
        source: { type: "buffer", bytes },
        limits: DEFAULT_LIMITS,
      }),
      "source_invalid",
    );
    expect(error.message).not.toContain(marker);
  });
});

function limits(overrides: Partial<KohoZipLimits> = {}): KohoZipLimits {
  return { ...DEFAULT_LIMITS, ...overrides };
}

async function openFixture(
  fixture: BuiltZipFixture,
  overrides: Partial<KohoZipLimits> = {},
): Promise<KohoZipReader> {
  return openBytes(fixture.bytes, overrides);
}

async function openBytes(
  bytes: Uint8Array,
  overrides: Partial<KohoZipLimits> = {},
): Promise<KohoZipReader> {
  const reader = await openKohoZip({
    source: { type: "buffer", bytes },
    limits: limits(overrides),
  });
  openReaders.add(reader);
  return reader;
}

async function expectCode(
  promise: Promise<unknown>,
  code: KohoZipError["code"],
): Promise<KohoZipError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(KohoZipError);
    expect(error).toMatchObject({ code });
    return error as KohoZipError;
  }
  throw new Error(`Expected KohoZipError code ${code}`);
}

function cloneFixtureBytes(fixture: BuiltZipFixture): Buffer {
  return Buffer.from(fixture.bytes);
}

function unicodePathExtra(rawName: Uint8Array, safeName: string): Buffer {
  const unicodeName = Buffer.from(safeName, "utf8");
  const data = Buffer.alloc(5 + unicodeName.byteLength);
  data.writeUInt8(1, 0);
  data.writeUInt32LE(calculateCrc32(rawName), 1);
  unicodeName.copy(data, 5);

  const field = Buffer.alloc(4 + data.byteLength);
  field.writeUInt16LE(0x7075, 0);
  field.writeUInt16LE(data.byteLength, 2);
  data.copy(field, 4);
  return field;
}
