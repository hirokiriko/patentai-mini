import { deflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const LOCAL_FILE_HEADER_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
const ZIP64_EOCD_SIZE = 56;
const ZIP64_LOCATOR_SIZE = 20;
const UTF8_FILE_NAME_FLAG = 0x0800;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

export const ZIP_FIXTURE_FIELD_OFFSETS = {
  local: {
    signature: 0,
    flags: 6,
    compressionMethod: 8,
    crc32: 14,
    compressedSize: 18,
    uncompressedSize: 22,
    fileNameLength: 26,
    extraFieldLength: 28,
  },
  central: {
    signature: 0,
    flags: 8,
    compressionMethod: 10,
    crc32: 16,
    compressedSize: 20,
    uncompressedSize: 24,
    fileNameLength: 28,
    extraFieldLength: 30,
    fileCommentLength: 32,
    diskStart: 34,
    relativeLocalHeaderOffset: 42,
  },
  eocd: {
    signature: 0,
    diskNumber: 4,
    centralDirectoryDisk: 6,
    entriesOnDisk: 8,
    entryCount: 10,
    centralDirectorySize: 12,
    centralDirectoryOffset: 16,
    commentLength: 20,
  },
  zip64Eocd: {
    signature: 0,
    recordPayloadSize: 4,
    diskNumber: 16,
    centralDirectoryDisk: 20,
    entriesOnDisk: 24,
    entryCount: 32,
    centralDirectorySize: 40,
    centralDirectoryOffset: 48,
  },
  zip64Locator: {
    signature: 0,
    zip64EocdDisk: 4,
    zip64EocdOffset: 8,
    totalDisks: 16,
  },
} as const;

export type ZipFixtureBytes = string | Uint8Array;

export interface ZipFixtureEntryInput {
  readonly fileName: ZipFixtureBytes;
  readonly data?: ZipFixtureBytes;
  /** 0 is stored, 8 is deflate, and any other value is emitted unchanged. */
  readonly compressionMethod?: number;
  /** Defaults to the UTF-8 filename flag. */
  readonly flags?: number;
  readonly localExtraFields?: ZipFixtureBytes;
  readonly centralExtraFields?: ZipFixtureBytes;
  /** Overrides the bytes placed after the local header. */
  readonly compressedBytes?: ZipFixtureBytes;
  readonly crc32?: number;
  readonly localCompressedSize?: number;
  readonly localUncompressedSize?: number;
  readonly centralCompressedSize?: number;
  readonly centralUncompressedSize?: number;
}

export interface BuildZipOptions {
  readonly entries: readonly ZipFixtureEntryInput[];
  readonly archiveZip64?: boolean;
  readonly comment?: ZipFixtureBytes;
}

export interface ZipFixtureEntryLayout {
  readonly localHeaderOffset: number;
  readonly localFileNameOffset: number;
  readonly dataOffset: number;
  readonly dataEndOffset: number;
  readonly centralHeaderOffset: number;
  readonly centralFileNameOffset: number;
  readonly actualCompressedSize: number;
  readonly actualUncompressedSize: number;
  readonly localDeclaredCompressedSize: number;
  readonly localDeclaredUncompressedSize: number;
  readonly centralDeclaredCompressedSize: number;
  readonly centralDeclaredUncompressedSize: number;
}

export interface BuiltZipFixture {
  readonly bytes: Buffer;
  readonly entries: readonly ZipFixtureEntryLayout[];
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly centralDirectoryEndOffset: number;
  readonly zip64EocdOffset: number | null;
  readonly zip64LocatorOffset: number | null;
  readonly eocdOffset: number;
  readonly commentOffset: number;
}

interface PreparedEntry {
  readonly fileName: Buffer;
  readonly data: Buffer;
  readonly compressedBytes: Buffer;
  readonly compressionMethod: number;
  readonly flags: number;
  readonly localExtraFields: Buffer;
  readonly centralExtraFields: Buffer;
  readonly crc32: number;
  readonly localCompressedSize: number;
  readonly localUncompressedSize: number;
  readonly centralCompressedSize: number;
  readonly centralUncompressedSize: number;
  readonly localHeaderOffset: number;
  readonly localFileNameOffset: number;
  readonly dataOffset: number;
  readonly dataEndOffset: number;
}

export function buildZip(options: BuildZipOptions): BuiltZipFixture {
  const comment = toBuffer(options.comment);
  assertUnsignedInteger(comment.byteLength, UINT16_MAX, "ZIP comment length");

  const localParts: Buffer[] = [];
  const preparedEntries: PreparedEntry[] = [];
  let cursor = 0;

  for (const entry of options.entries) {
    const fileName = toBuffer(entry.fileName);
    const data = toBuffer(entry.data);
    assertUnsignedInteger(fileName.byteLength, UINT16_MAX, "filename length");

    const compressionMethod = entry.compressionMethod ?? 0;
    const flags = entry.flags ?? UTF8_FILE_NAME_FLAG;
    const localExtraFields = toBuffer(entry.localExtraFields);
    const centralExtraFields = toBuffer(entry.centralExtraFields);
    assertUnsignedInteger(compressionMethod, UINT16_MAX, "compression method");
    assertUnsignedInteger(flags, UINT16_MAX, "general purpose flags");
    assertUnsignedInteger(
      localExtraFields.byteLength,
      UINT16_MAX,
      "local extra-field length",
    );
    assertUnsignedInteger(
      centralExtraFields.byteLength,
      UINT16_MAX,
      "central extra-field length",
    );

    const compressedBytes =
      entry.compressedBytes === undefined
        ? compressFixtureData(data, compressionMethod)
        : toBuffer(entry.compressedBytes);
    const crc32 = entry.crc32 ?? calculateCrc32(data);
    const localCompressedSize =
      entry.localCompressedSize ?? compressedBytes.byteLength;
    const localUncompressedSize =
      entry.localUncompressedSize ?? data.byteLength;
    const centralCompressedSize =
      entry.centralCompressedSize ?? compressedBytes.byteLength;
    const centralUncompressedSize =
      entry.centralUncompressedSize ?? data.byteLength;

    assertUnsignedInteger(crc32, UINT32_MAX, "CRC32");
    assertUnsignedInteger(
      localCompressedSize,
      UINT32_MAX,
      "local compressed size",
    );
    assertUnsignedInteger(
      localUncompressedSize,
      UINT32_MAX,
      "local uncompressed size",
    );
    assertUnsignedInteger(
      centralCompressedSize,
      UINT32_MAX,
      "central compressed size",
    );
    assertUnsignedInteger(
      centralUncompressedSize,
      UINT32_MAX,
      "central uncompressed size",
    );

    const localHeaderOffset = cursor;
    const localHeader = Buffer.alloc(LOCAL_FILE_HEADER_SIZE);
    localHeader.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(compressionMethod, 8);
    localHeader.writeUInt32LE(crc32, 14);
    localHeader.writeUInt32LE(localCompressedSize, 18);
    localHeader.writeUInt32LE(localUncompressedSize, 22);
    localHeader.writeUInt16LE(fileName.byteLength, 26);
    localHeader.writeUInt16LE(localExtraFields.byteLength, 28);

    const localFileNameOffset = localHeaderOffset + localHeader.byteLength;
    const dataOffset =
      localFileNameOffset + fileName.byteLength + localExtraFields.byteLength;
    const dataEndOffset = dataOffset + compressedBytes.byteLength;
    localParts.push(localHeader, fileName, localExtraFields, compressedBytes);
    cursor = dataEndOffset;

    preparedEntries.push({
      fileName,
      data,
      compressedBytes,
      compressionMethod,
      flags,
      localExtraFields,
      centralExtraFields,
      crc32,
      localCompressedSize,
      localUncompressedSize,
      centralCompressedSize,
      centralUncompressedSize,
      localHeaderOffset,
      localFileNameOffset,
      dataOffset,
      dataEndOffset,
    });
  }

  const centralDirectoryOffset = cursor;
  assertUnsignedInteger(
    centralDirectoryOffset,
    UINT32_MAX,
    "central directory offset",
  );
  const centralParts: Buffer[] = [];
  const layouts: ZipFixtureEntryLayout[] = [];

  for (const entry of preparedEntries) {
    const centralHeaderOffset = cursor;
    const centralHeader = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_SIZE);
    centralHeader.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
    centralHeader.writeUInt16LE(0x0314, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(entry.flags, 8);
    centralHeader.writeUInt16LE(entry.compressionMethod, 10);
    centralHeader.writeUInt32LE(entry.crc32, 16);
    centralHeader.writeUInt32LE(entry.centralCompressedSize, 20);
    centralHeader.writeUInt32LE(entry.centralUncompressedSize, 24);
    centralHeader.writeUInt16LE(entry.fileName.byteLength, 28);
    centralHeader.writeUInt16LE(entry.centralExtraFields.byteLength, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(
      isDirectoryName(entry.fileName) ? 0x10 : 0,
      38,
    );
    centralHeader.writeUInt32LE(entry.localHeaderOffset, 42);

    const centralFileNameOffset =
      centralHeaderOffset + centralHeader.byteLength;
    centralParts.push(centralHeader, entry.fileName, entry.centralExtraFields);
    cursor =
      centralFileNameOffset +
      entry.fileName.byteLength +
      entry.centralExtraFields.byteLength;

    layouts.push({
      localHeaderOffset: entry.localHeaderOffset,
      localFileNameOffset: entry.localFileNameOffset,
      dataOffset: entry.dataOffset,
      dataEndOffset: entry.dataEndOffset,
      centralHeaderOffset,
      centralFileNameOffset,
      actualCompressedSize: entry.compressedBytes.byteLength,
      actualUncompressedSize: entry.data.byteLength,
      localDeclaredCompressedSize: entry.localCompressedSize,
      localDeclaredUncompressedSize: entry.localUncompressedSize,
      centralDeclaredCompressedSize: entry.centralCompressedSize,
      centralDeclaredUncompressedSize: entry.centralUncompressedSize,
    });
  }

  const centralDirectoryEndOffset = cursor;
  const centralDirectorySize =
    centralDirectoryEndOffset - centralDirectoryOffset;
  assertUnsignedInteger(
    centralDirectorySize,
    UINT32_MAX,
    "central directory size",
  );

  const metadataParts: Buffer[] = [];
  let zip64EocdOffset: number | null = null;
  let zip64LocatorOffset: number | null = null;

  if (options.archiveZip64 === true) {
    zip64EocdOffset = cursor;
    const zip64Eocd = Buffer.alloc(ZIP64_EOCD_SIZE);
    zip64Eocd.writeUInt32LE(ZIP64_EOCD_SIGNATURE, 0);
    zip64Eocd.writeBigUInt64LE(BigInt(44), 4);
    zip64Eocd.writeUInt16LE(45, 12);
    zip64Eocd.writeUInt16LE(45, 14);
    zip64Eocd.writeUInt32LE(0, 16);
    zip64Eocd.writeUInt32LE(0, 20);
    zip64Eocd.writeBigUInt64LE(BigInt(preparedEntries.length), 24);
    zip64Eocd.writeBigUInt64LE(BigInt(preparedEntries.length), 32);
    zip64Eocd.writeBigUInt64LE(BigInt(centralDirectorySize), 40);
    zip64Eocd.writeBigUInt64LE(BigInt(centralDirectoryOffset), 48);
    metadataParts.push(zip64Eocd);
    cursor += zip64Eocd.byteLength;

    zip64LocatorOffset = cursor;
    const zip64Locator = Buffer.alloc(ZIP64_LOCATOR_SIZE);
    zip64Locator.writeUInt32LE(ZIP64_LOCATOR_SIGNATURE, 0);
    zip64Locator.writeUInt32LE(0, 4);
    zip64Locator.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
    zip64Locator.writeUInt32LE(1, 16);
    metadataParts.push(zip64Locator);
    cursor += zip64Locator.byteLength;
  } else {
    assertUnsignedInteger(
      preparedEntries.length,
      UINT16_MAX,
      "entry count",
    );
  }

  const eocdOffset = cursor;
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  if (options.archiveZip64 === true) {
    eocd.writeUInt16LE(UINT16_MAX, 4);
    eocd.writeUInt16LE(UINT16_MAX, 6);
    eocd.writeUInt16LE(UINT16_MAX, 8);
    eocd.writeUInt16LE(UINT16_MAX, 10);
    eocd.writeUInt32LE(UINT32_MAX, 12);
    eocd.writeUInt32LE(UINT32_MAX, 16);
  } else {
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(preparedEntries.length, 8);
    eocd.writeUInt16LE(preparedEntries.length, 10);
    eocd.writeUInt32LE(centralDirectorySize, 12);
    eocd.writeUInt32LE(centralDirectoryOffset, 16);
  }
  eocd.writeUInt16LE(comment.byteLength, 20);
  metadataParts.push(eocd);
  cursor += eocd.byteLength;
  const commentOffset = cursor;
  metadataParts.push(comment);

  return {
    bytes: Buffer.concat([...localParts, ...centralParts, ...metadataParts]),
    entries: layouts,
    centralDirectoryOffset,
    centralDirectorySize,
    centralDirectoryEndOffset,
    zip64EocdOffset,
    zip64LocatorOffset,
    eocdOffset,
    commentOffset,
  };
}

export function calculateCrc32(bytes: Uint8Array): number {
  let crc = UINT32_MAX;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ UINT32_MAX) >>> 0;
}

function compressFixtureData(data: Buffer, compressionMethod: number): Buffer {
  if (compressionMethod === 8) {
    return deflateRawSync(data, { level: 9 });
  }
  return data;
}

function toBuffer(value: ZipFixtureBytes | undefined): Buffer {
  if (value === undefined) return Buffer.alloc(0);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function isDirectoryName(fileName: Buffer): boolean {
  const finalByte = fileName[fileName.byteLength - 1];
  return finalByte === 0x2f || finalByte === 0x5c;
}

function assertUnsignedInteger(
  value: number,
  maximum: number,
  label: string,
): void {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an unsigned integer`);
  }
}
