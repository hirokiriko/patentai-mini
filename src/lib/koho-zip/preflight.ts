import { KohoZipError } from "./errors";
import { UniqueByteRangeCounter } from "./ranges";
import type { InternalZipSource } from "./source";
import type { KohoZipLimits } from "./types";

const EOCD_SIGNATURE = 0x06054b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_LOCATOR_SIZE = 20;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_EOCD_MIN_SIZE = 56;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const CENTRAL_DIRECTORY_DIGITAL_SIGNATURE = 0x05054b50;

export interface KohoZipPreflight {
  zip64: boolean;
  commentLength: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  declaredEntryCount: number;
  observedEntryCount: number;
  totalDeclaredCompressedBytes: number;
  totalDeclaredUncompressedBytes: number;
  strongEncryptionEntries: readonly StrongEncryptionEntryObservation[];
}

export interface StrongEncryptionEntryObservation {
  readonly entryId: number;
  readonly headerOffset: number;
  readonly compressionMethod: number;
}

interface CentralDirectoryObservation {
  count: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  strongEncryptionEntries: readonly StrongEncryptionEntryObservation[];
}

interface ValidatedCentralDirectoryEntry {
  strongEncryption: boolean;
  compressedSize: number;
  uncompressedSize: number;
}

interface EocdValues {
  diskNumber: number;
  centralDirectoryDisk: number;
  entriesOnDisk: number;
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
  commentLength: number;
}

interface Zip64Values {
  recordOffset: number;
  diskNumber: number;
  centralDirectoryDisk: number;
  entriesOnDisk: number;
  entryCount: number;
  centralDirectorySize: number;
  centralDirectoryOffset: number;
}

export async function preflightKohoZip(
  source: InternalZipSource,
  limits: KohoZipLimits,
  ranges: UniqueByteRangeCounter,
): Promise<KohoZipPreflight> {
  if (source.size < EOCD_MIN_SIZE) {
    throw new KohoZipError("invalid_zip");
  }

  const tailLength = Math.min(
    source.size,
    ZIP64_LOCATOR_SIZE + EOCD_MIN_SIZE + MAX_COMMENT_SIZE,
  );
  const tailOffset = source.size - tailLength;
  const tail = await readExact(source, ranges, tailOffset, tailLength);
  const candidateOffsets: number[] = [];

  for (let offset = 0; offset <= tail.length - EOCD_MIN_SIZE; offset += 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (commentLength === tail.length - offset - EOCD_MIN_SIZE) {
      candidateOffsets.push(offset);
    }
  }

  if (candidateOffsets.length !== 1) {
    throw new KohoZipError("invalid_zip");
  }

  const eocdTailOffset = candidateOffsets[0];
  const eocdOffset = tailOffset + eocdTailOffset;
  const eocd = parseEocd(tail.subarray(eocdTailOffset));
  const locatorTailOffset = eocdTailOffset - ZIP64_LOCATOR_SIZE;
  const hasZip64Locator =
    locatorTailOffset >= 0 &&
    tail.readUInt32LE(locatorTailOffset) === ZIP64_LOCATOR_SIGNATURE;
  let values: EocdValues | Zip64Values = eocd;
  let metadataStart = eocdOffset;
  if (hasZip64Locator) {
    const locator = tail.subarray(
      locatorTailOffset,
      locatorTailOffset + ZIP64_LOCATOR_SIZE,
    );
    const locatorDisk = locator.readUInt32LE(4);
    const zip64Offset = readSafeUInt64(locator, 8);
    const totalDisks = locator.readUInt32LE(16);
    if (locatorDisk !== 0 || totalDisks !== 1) {
      throw new KohoZipError("multi_disk_unsupported");
    }

    const zip64Buffer = await readExact(
      source,
      ranges,
      zip64Offset,
      ZIP64_EOCD_MIN_SIZE,
    );
    if (zip64Buffer.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
      throw new KohoZipError("invalid_zip");
    }
    const recordPayloadSize = readSafeUInt64(zip64Buffer, 4);
    if (recordPayloadSize < 44) {
      throw new KohoZipError("invalid_zip");
    }
    const recordEnd = safeAdd(zip64Offset, safeAdd(12, recordPayloadSize, true), true);
    if (recordEnd !== eocdOffset - ZIP64_LOCATOR_SIZE) {
      throw new KohoZipError("invalid_zip");
    }

    const zip64Values: Zip64Values = {
      recordOffset: zip64Offset,
      diskNumber: zip64Buffer.readUInt32LE(16),
      centralDirectoryDisk: zip64Buffer.readUInt32LE(20),
      entriesOnDisk: readSafeUInt64(zip64Buffer, 24),
      entryCount: readSafeUInt64(zip64Buffer, 32),
      centralDirectorySize: readSafeUInt64(zip64Buffer, 40),
      centralDirectoryOffset: readSafeUInt64(zip64Buffer, 48),
    };
    validateLegacyZip64Agreement(eocd, zip64Values);
    values = zip64Values;
    metadataStart = zip64Offset;
  }

  if (
    values.diskNumber !== 0 ||
    values.centralDirectoryDisk !== 0 ||
    values.entriesOnDisk !== values.entryCount
  ) {
    throw new KohoZipError("multi_disk_unsupported");
  }
  if (values.entryCount > limits.maxEntries) {
    throw new KohoZipError("entry_count_limit");
  }
  if (values.centralDirectorySize > limits.maxCentralDirectoryBytes) {
    throw new KohoZipError("central_directory_too_large");
  }

  const centralDirectoryEnd = safeAdd(
    values.centralDirectoryOffset,
    values.centralDirectorySize,
    hasZip64Locator,
  );
  if (
    centralDirectoryEnd > source.size ||
    centralDirectoryEnd !== metadataStart
  ) {
    throw new KohoZipError("invalid_zip");
  }

  const observation = await inspectCentralDirectoryEntries(
    source,
    ranges,
    values.centralDirectoryOffset,
    centralDirectoryEnd,
    limits,
  );
  if (observation.count !== values.entryCount) {
    throw new KohoZipError("invalid_zip");
  }

  return {
    zip64: hasZip64Locator,
    commentLength: eocd.commentLength,
    centralDirectoryOffset: values.centralDirectoryOffset,
    centralDirectorySize: values.centralDirectorySize,
    declaredEntryCount: values.entryCount,
    observedEntryCount: observation.count,
    totalDeclaredCompressedBytes: observation.totalCompressedBytes,
    totalDeclaredUncompressedBytes: observation.totalUncompressedBytes,
    strongEncryptionEntries: observation.strongEncryptionEntries,
  };
}

function parseEocd(buffer: Buffer): EocdValues {
  return {
    diskNumber: buffer.readUInt16LE(4),
    centralDirectoryDisk: buffer.readUInt16LE(6),
    entriesOnDisk: buffer.readUInt16LE(8),
    entryCount: buffer.readUInt16LE(10),
    centralDirectorySize: buffer.readUInt32LE(12),
    centralDirectoryOffset: buffer.readUInt32LE(16),
    commentLength: buffer.readUInt16LE(20),
  };
}

function validateLegacyZip64Agreement(
  legacy: EocdValues,
  zip64: Zip64Values,
): void {
  const pairs: readonly [number, number, number][] = [
    [legacy.diskNumber, 0xffff, zip64.diskNumber],
    [legacy.centralDirectoryDisk, 0xffff, zip64.centralDirectoryDisk],
    [legacy.entriesOnDisk, 0xffff, zip64.entriesOnDisk],
    [legacy.entryCount, 0xffff, zip64.entryCount],
    [legacy.centralDirectorySize, 0xffffffff, zip64.centralDirectorySize],
    [legacy.centralDirectoryOffset, 0xffffffff, zip64.centralDirectoryOffset],
  ];
  if (pairs.some(([legacyValue, sentinel, actual]) => legacyValue !== sentinel && legacyValue !== actual)) {
    throw new KohoZipError("invalid_zip");
  }
}

async function inspectCentralDirectoryEntries(
  source: InternalZipSource,
  ranges: UniqueByteRangeCounter,
  start: number,
  end: number,
  limits: KohoZipLimits,
): Promise<CentralDirectoryObservation> {
  let cursor = start;
  let count = 0;
  let sawDigitalSignature = false;
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  const strongEncryptionEntries: StrongEncryptionEntryObservation[] = [];

  while (cursor < end) {
    const signatureBuffer = await readExact(source, ranges, cursor, 4);
    const signature = signatureBuffer.readUInt32LE(0);
    if (signature === CENTRAL_DIRECTORY_DIGITAL_SIGNATURE) {
      if (sawDigitalSignature) throw new KohoZipError("invalid_zip");
      const header = await readExact(source, ranges, cursor, 6);
      const recordEnd = safeAdd(cursor, 6 + header.readUInt16LE(4), false);
      if (recordEnd !== end) throw new KohoZipError("invalid_zip");
      sawDigitalSignature = true;
      cursor = recordEnd;
      continue;
    }
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE || sawDigitalSignature) {
      throw new KohoZipError("invalid_zip");
    }
    if (count >= limits.maxEntries) {
      throw new KohoZipError("entry_count_limit");
    }

    const header = await readExact(
      source,
      ranges,
      cursor,
      CENTRAL_DIRECTORY_HEADER_SIZE,
    );
    const variableSize =
      header.readUInt16LE(28) +
      header.readUInt16LE(30) +
      header.readUInt16LE(32);
    assertClassicSizeFits(
      header.readUInt32LE(20),
      totalCompressedBytes,
      limits.maxEntryCompressedBytes,
      limits.maxTotalCompressedBytes,
      "entry_compressed_limit",
      "total_compressed_limit",
    );
    assertClassicSizeFits(
      header.readUInt32LE(24),
      totalUncompressedBytes,
      limits.maxEntryUncompressedBytes,
      limits.maxTotalUncompressedBytes,
      "entry_uncompressed_limit",
      "total_uncompressed_limit",
    );
    const recordEnd = safeAdd(
      cursor,
      CENTRAL_DIRECTORY_HEADER_SIZE + variableSize,
      false,
    );
    if (recordEnd > end) throw new KohoZipError("invalid_zip");
    const fileNameLength = header.readUInt16LE(28);
    const extraFieldLength = header.readUInt16LE(30);
    const extraFields =
      extraFieldLength === 0
        ? Buffer.alloc(0)
        : await readExact(
            source,
            ranges,
            cursor + CENTRAL_DIRECTORY_HEADER_SIZE + fileNameLength,
            extraFieldLength,
          );
    const validatedEntry = validateCentralDirectoryEntry(
      header,
      extraFields,
      start,
    );
    totalCompressedBytes = addDeclaredSize(
      totalCompressedBytes,
      validatedEntry.compressedSize,
      limits.maxEntryCompressedBytes,
      limits.maxTotalCompressedBytes,
      "entry_compressed_limit",
      "total_compressed_limit",
    );
    totalUncompressedBytes = addDeclaredSize(
      totalUncompressedBytes,
      validatedEntry.uncompressedSize,
      limits.maxEntryUncompressedBytes,
      limits.maxTotalUncompressedBytes,
      "entry_uncompressed_limit",
      "total_uncompressed_limit",
    );
    if (validatedEntry.strongEncryption) {
      strongEncryptionEntries.push(
        Object.freeze({
          entryId: count,
          headerOffset: cursor,
          compressionMethod: header.readUInt16LE(10),
        }),
      );
    }
    count += 1;
    if (!Number.isSafeInteger(count) || count > limits.maxEntries) {
      throw new KohoZipError("entry_count_limit");
    }
    cursor = recordEnd;
  }

  return {
    count,
    totalCompressedBytes,
    totalUncompressedBytes,
    strongEncryptionEntries: Object.freeze(strongEncryptionEntries),
  };
}

function validateCentralDirectoryEntry(
  header: Buffer,
  extraFields: Buffer,
  centralDirectoryStart: number,
): ValidatedCentralDirectoryEntry {
  const generalPurposeBitFlag = header.readUInt16LE(8);
  const strongEncryption = (generalPurposeBitFlag & 0x40) !== 0;

  const uncompressedSize32 = header.readUInt32LE(24);
  const compressedSize32 = header.readUInt32LE(20);
  const relativeOffset32 = header.readUInt32LE(42);
  const diskStart16 = header.readUInt16LE(34);
  const zip64Extra = findZip64Extra(extraFields);

  let cursor = 0;
  const takeUInt64 = (): number => {
    if (zip64Extra === null || cursor + 8 > zip64Extra.length) {
      throw new KohoZipError("invalid_zip");
    }
    const value = readSafeUInt64(zip64Extra, cursor);
    cursor += 8;
    return value;
  };

  const uncompressedSize =
    uncompressedSize32 === 0xffffffff && zip64Extra !== null
      ? takeUInt64()
      : uncompressedSize32;
  const compressedSize =
    compressedSize32 === 0xffffffff && zip64Extra !== null
      ? takeUInt64()
      : compressedSize32;
  const relativeOffset =
    relativeOffset32 === 0xffffffff && zip64Extra !== null
      ? takeUInt64()
      : relativeOffset32;
  if (relativeOffset >= centralDirectoryStart) {
    throw new KohoZipError("invalid_zip");
  }

  let diskStart = diskStart16;
  if (diskStart16 === 0xffff && zip64Extra !== null) {
    if (cursor + 4 > zip64Extra.length) {
      throw new KohoZipError("invalid_zip");
    }
    diskStart = zip64Extra.readUInt32LE(cursor);
  }
  if (diskStart !== 0) {
    throw new KohoZipError("multi_disk_unsupported");
  }
  return { strongEncryption, compressedSize, uncompressedSize };
}

function findZip64Extra(extraFields: Buffer): Buffer | null {
  let cursor = 0;
  let zip64Extra: Buffer | null = null;
  while (cursor < extraFields.length) {
    if (cursor + 4 > extraFields.length) {
      throw new KohoZipError("invalid_zip");
    }
    const fieldId = extraFields.readUInt16LE(cursor);
    const fieldSize = extraFields.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + fieldSize;
    if (dataEnd > extraFields.length) {
      throw new KohoZipError("invalid_zip");
    }
    if (fieldId === 0x0001) {
      if (zip64Extra !== null) throw new KohoZipError("invalid_zip");
      zip64Extra = extraFields.subarray(dataStart, dataEnd);
    }
    cursor = dataEnd;
  }
  return zip64Extra;
}

function assertClassicSizeFits(
  value: number,
  total: number,
  entryLimit: number,
  totalLimit: number,
  entryCode: "entry_compressed_limit" | "entry_uncompressed_limit",
  totalCode: "total_compressed_limit" | "total_uncompressed_limit",
): void {
  if (value === 0xffffffff) return;
  if (value > entryLimit) throw new KohoZipError(entryCode);
  if (total > totalLimit - value) throw new KohoZipError(totalCode);
}

function addDeclaredSize(
  total: number,
  value: number,
  entryLimit: number,
  totalLimit: number,
  entryCode: "entry_compressed_limit" | "entry_uncompressed_limit",
  totalCode: "total_compressed_limit" | "total_uncompressed_limit",
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new KohoZipError("zip64_value_unsafe");
  }
  if (value > entryLimit) throw new KohoZipError(entryCode);
  if (total > totalLimit - value) throw new KohoZipError(totalCode);
  return total + value;
}

async function readExact(
  source: InternalZipSource,
  ranges: UniqueByteRangeCounter,
  start: number,
  length: number,
): Promise<Buffer> {
  const end = safeAdd(start, length, false);
  if (length <= 0 || end > source.size) {
    throw new KohoZipError("invalid_zip");
  }
  ranges.add(start, end);

  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = await source.read(
      output,
      offset,
      length - offset,
      start + offset,
    );
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) {
      throw new KohoZipError("source_invalid");
    }
    offset += bytesRead;
  }
  return output;
}

function readSafeUInt64(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new KohoZipError("zip64_value_unsafe");
  }
  return Number(value);
}

function safeAdd(left: number, right: number, zip64: boolean): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new KohoZipError(zip64 ? "zip64_value_unsafe" : "invalid_zip");
  }
  return result;
}
