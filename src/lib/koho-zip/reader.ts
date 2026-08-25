import { Readable } from "node:stream";

import {
  Entry,
  RandomAccessReader,
  type LocalFileHeader,
  type ZipFile,
  fromRandomAccessReaderPromise,
} from "yauzl";

import { asKohoZipError, KohoZipError } from "./errors";
import { validateLimits } from "./limits";
import { assertSafeRawEntryPath, inspectEntryPath } from "./path";
import {
  preflightKohoZip,
  type StrongEncryptionEntryObservation,
  type YauzlOpeningRecord,
} from "./preflight";
import { UniqueByteRangeCounter } from "./ranges";
import { openInternalSource, type InternalZipSource } from "./source";
import type {
  KohoZipEntry,
  KohoZipEntryRole,
  KohoZipLimits,
  KohoZipOpenInput,
  KohoZipPathCandidate,
  KohoZipReader,
  KohoZipSource,
  KohoZipSummary,
} from "./types";

class TrackingRandomAccessReader extends RandomAccessReader {
  private metadataPhase = true;
  private openingTailServed = false;

  constructor(
    private readonly source: InternalZipSource,
    private readonly metadataRanges: UniqueByteRangeCounter,
    private readonly targetedMetadataRanges: UniqueByteRangeCounter,
    private readonly openingRecord: YauzlOpeningRecord,
    private readonly strongEncryptionEntries: readonly StrongEncryptionEntryObservation[],
  ) {
    super();
  }

  finishMetadata(): void {
    this.metadataPhase = false;
  }

  _readStreamForRange(start: number, end: number): Readable {
    try {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end <= start ||
        end > this.source.size
      ) {
        throw new KohoZipError("invalid_zip");
      }
      if (this.metadataPhase && !this.openingTailServed) {
        const expectedStart =
          this.source.size - Math.min(this.source.size, 20 + 22 + 0xffff);
        if (start !== expectedStart || end !== this.source.size) {
          throw new KohoZipError("invalid_zip");
        }
        this.openingTailServed = true;
        return createSyntheticYauzlOpeningTail(
          start,
          end,
          this.openingRecord,
        );
      }
      if (this.metadataPhase) {
        this.metadataRanges.add(start, end);
        this.targetedMetadataRanges.add(start, end);
      }
      const sourceStream = this.source.createReadStream(start, end);
      if (!this.metadataPhase || this.strongEncryptionEntries.length === 0) {
        return sourceStream;
      }
      return createStrongEncryptionMaskingStream(
        sourceStream,
        start,
        this.strongEncryptionEntries,
      );
    } catch (error) {
      const stableError = asKohoZipError(error);
      return new Readable({
        read() {
          this.destroy(stableError);
        },
      });
    }
  }

  close(callback: (error: Error | null) => void): void {
    void this.source.close().then(
      () => callback(null),
      () => callback(new KohoZipError("source_invalid")),
    );
  }
}

interface EnumeratedZip {
  entries: readonly KohoZipEntry[];
  yauzlEntries: ReadonlyMap<number, Entry>;
  observedEntryCount: number;
  totalCompressedBytes: number;
  totalUncompressedBytes: number;
  roleCounts: Readonly<Record<KohoZipEntryRole, number>>;
  candidateCounts: Readonly<Record<KohoZipPathCandidate, number>>;
  encryptedEntryCount: number;
  unsupportedCompressionEntryCount: number;
}

export async function openKohoZip(
  input: KohoZipOpenInput,
): Promise<KohoZipReader> {
  if (input === null || typeof input !== "object") {
    throw new KohoZipError("invalid_limits");
  }
  let limits: KohoZipLimits;
  try {
    limits = snapshotLimits(input.limits);
    validateLimits(limits);
  } catch {
    throw new KohoZipError("invalid_limits");
  }
  let sourceInput: KohoZipSource;
  try {
    sourceInput = snapshotSource(input.source);
  } catch {
    throw new KohoZipError("source_invalid");
  }

  let source: InternalZipSource | null = null;
  let zipFile: ZipFile | null = null;
  try {
    source = await openInternalSource(sourceInput, limits.maxSourceBytes);
    const metadataRanges = new UniqueByteRangeCounter(
      limits.maxCentralDirectoryBytes,
    );
    const targetedMetadataRanges = new UniqueByteRangeCounter(
      limits.maxCentralDirectoryBytes,
    );
    const preflight = await preflightKohoZip(
      source,
      limits,
      metadataRanges,
      targetedMetadataRanges,
    );
    const randomAccessReader = new TrackingRandomAccessReader(
      source,
      metadataRanges,
      targetedMetadataRanges,
      preflight.yauzlOpeningRecord,
      preflight.strongEncryptionEntries,
    );
    zipFile = await fromRandomAccessReaderPromise(
      randomAccessReader,
      source.size,
      {
        autoClose: false,
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: false,
      },
    );
    if (
      !Number.isSafeInteger(zipFile.entryCount) ||
      zipFile.entryCount !== preflight.declaredEntryCount
    ) {
      throw new KohoZipError("invalid_zip");
    }

    const enumerated = await enumerateEntries(
      zipFile,
      preflight.centralDirectoryOffset,
      limits,
      new Map(
        preflight.strongEncryptionEntries.map((entry) => [
          entry.entryId,
          entry.compressionMethod,
        ]),
      ),
    );
    if (
      enumerated.observedEntryCount !== preflight.observedEntryCount ||
      enumerated.observedEntryCount !== preflight.declaredEntryCount ||
      enumerated.totalCompressedBytes !==
        preflight.totalDeclaredCompressedBytes ||
      enumerated.totalUncompressedBytes !==
        preflight.totalDeclaredUncompressedBytes
    ) {
      throw new KohoZipError("invalid_zip");
    }
    randomAccessReader.finishMetadata();

    const summary: KohoZipSummary = Object.freeze({
      sourceType: source.type,
      sourceName: source.sourceName,
      sourceSize: source.size,
      zip64: preflight.zip64,
      commentLength: preflight.commentLength,
      eocdTailBytesRead: preflight.eocdTailBytesRead,
      centralDirectoryOffset: preflight.centralDirectoryOffset,
      declaredCentralDirectorySize: preflight.centralDirectorySize,
      metadataBytesRead: metadataRanges.total,
      targetedMetadataBytesRead: targetedMetadataRanges.total,
      declaredEntryCount: preflight.declaredEntryCount,
      observedEntryCount: enumerated.observedEntryCount,
      totalDeclaredCompressedBytes: enumerated.totalCompressedBytes,
      totalDeclaredUncompressedBytes: enumerated.totalUncompressedBytes,
      roleCounts: enumerated.roleCounts,
      candidateCounts: enumerated.candidateCounts,
      encryptedEntryCount: enumerated.encryptedEntryCount,
      unsupportedCompressionEntryCount:
        enumerated.unsupportedCompressionEntryCount,
    });

    return new KohoZipReaderImpl(
      source,
      zipFile,
      limits,
      preflight.centralDirectoryOffset,
      enumerated.entries,
      enumerated.yauzlEntries,
      summary,
    );
  } catch (error) {
    if (zipFile?.isOpen) zipFile.close();
    if (source !== null) await source.close().catch(() => undefined);
    throw asKohoZipError(error);
  }
}

function createSyntheticYauzlOpeningTail(
  start: number,
  end: number,
  openingRecord: YauzlOpeningRecord,
): Readable {
  const output = Buffer.alloc(end - start);
  copyOpeningRecordBytes(
    output,
    start,
    end,
    openingRecord.eocdOffset,
    openingRecord.eocdBytes,
  );
  if (
    openingRecord.locatorOffset !== null &&
    openingRecord.locatorBytes !== null
  ) {
    copyOpeningRecordBytes(
      output,
      start,
      end,
      openingRecord.locatorOffset,
      openingRecord.locatorBytes,
    );
  }
  return Readable.from([output]);
}

function copyOpeningRecordBytes(
  output: Buffer,
  rangeStart: number,
  rangeEnd: number,
  recordOffset: number,
  recordBytes: Buffer,
): void {
  const recordEnd = recordOffset + recordBytes.byteLength;
  if (recordOffset < rangeStart || recordEnd > rangeEnd) {
    throw new KohoZipError("invalid_zip");
  }
  recordBytes.copy(output, recordOffset - rangeStart);
}

async function enumerateEntries(
  zipFile: ZipFile,
  centralDirectoryOffset: number,
  limits: KohoZipLimits,
  strongEncryptionMethods: ReadonlyMap<number, number>,
): Promise<EnumeratedZip> {
  const entries: KohoZipEntry[] = [];
  const yauzlEntries = new Map<number, Entry>();
  const normalizedPaths = new Set<string>();
  const localHeaderOffsets = new Set<number>();
  const roleCounts = createRoleCounts();
  const candidateCounts = createCandidateCounts();
  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  let encryptedEntryCount = 0;
  let unsupportedCompressionEntryCount = 0;

  for await (const entry of zipFile.eachEntry()) {
    if (entries.length >= limits.maxEntries) {
      throw new KohoZipError("entry_count_limit");
    }
    validateEntryNumbers(entry, centralDirectoryOffset);
    if (localHeaderOffsets.has(entry.relativeOffsetOfLocalHeader)) {
      throw new KohoZipError("invalid_zip");
    }
    localHeaderOffsets.add(entry.relativeOffsetOfLocalHeader);
    if (entry.compressedSize > limits.maxEntryCompressedBytes) {
      throw new KohoZipError("entry_compressed_limit");
    }
    if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new KohoZipError("entry_uncompressed_limit");
    }
    totalCompressedBytes = addWithinLimit(
      totalCompressedBytes,
      entry.compressedSize,
      limits.maxTotalCompressedBytes,
      "total_compressed_limit",
    );
    totalUncompressedBytes = addWithinLimit(
      totalUncompressedBytes,
      entry.uncompressedSize,
      limits.maxTotalUncompressedBytes,
      "total_uncompressed_limit",
    );

    assertSafeRawEntryPath(entry.fileNameRaw);
    const inspectedPath = inspectEntryPath(entry.fileName);
    if (normalizedPaths.has(inspectedPath.normalizedPath)) {
      throw new KohoZipError("duplicate_entry_path");
    }
    normalizedPaths.add(inspectedPath.normalizedPath);
    if (
      inspectedPath.isDirectory &&
      (entry.compressedSize !== 0 || entry.uncompressedSize !== 0)
    ) {
      throw new KohoZipError("entry_size_mismatch");
    }

    const id = entries.length;
    const strongEncryptionMethod = strongEncryptionMethods.get(id);
    const compressionMethod = strongEncryptionMethod ?? entry.compressionMethod;
    const encrypted = entry.isEncrypted() || strongEncryptionMethod !== undefined;
    const supportedCompression =
      compressionMethod === 0 || compressionMethod === 8;
    const issues = [];
    if (encrypted) {
      encryptedEntryCount += 1;
      issues.push(
        Object.freeze({
          code: "encrypted_entry" as const,
          message: "Encrypted entry data is not readable",
        }),
      );
    }
    if (!supportedCompression) {
      unsupportedCompressionEntryCount += 1;
      issues.push(
        Object.freeze({
          code: "unsupported_compression" as const,
          message: "Entry compression is not supported",
        }),
      );
    }

    const publicEntry: KohoZipEntry = Object.freeze({
      id,
      rawFileNameBase64: entry.fileNameRaw.toString("base64"),
      decodedPath: entry.fileName,
      normalizedPath: inspectedPath.normalizedPath,
      isDirectory: inspectedPath.isDirectory,
      compressionMethod,
      compressedSize: entry.compressedSize,
      uncompressedSize: entry.uncompressedSize,
      crc32: entry.crc32,
      encrypted,
      role: inspectedPath.role,
      pathCandidate: inspectedPath.pathCandidate,
      canRead:
        !inspectedPath.isDirectory && !encrypted && supportedCompression,
      issues: Object.freeze(issues),
    });
    entries.push(publicEntry);
    yauzlEntries.set(id, entry);
    roleCounts[publicEntry.role] += 1;
    candidateCounts[publicEntry.pathCandidate] += 1;
  }

  return {
    entries: Object.freeze(entries),
    yauzlEntries,
    observedEntryCount: entries.length,
    totalCompressedBytes,
    totalUncompressedBytes,
    roleCounts: Object.freeze(roleCounts),
    candidateCounts: Object.freeze(candidateCounts),
    encryptedEntryCount,
    unsupportedCompressionEntryCount,
  };
}

class KohoZipReaderImpl implements KohoZipReader {
  private closed = false;
  private readInProgress = false;
  private activeStream: Readable | null = null;
  private closePromise: Promise<void> | null = null;
  private totalReadUncompressedBytes = 0;
  private backgroundError: KohoZipError | null = null;

  constructor(
    private readonly source: InternalZipSource,
    private readonly zipFile: ZipFile,
    private readonly limits: KohoZipLimits,
    private readonly centralDirectoryOffset: number,
    private readonly entryList: readonly KohoZipEntry[],
    private readonly yauzlEntries: ReadonlyMap<number, Entry>,
    private readonly packageSummary: KohoZipSummary,
  ) {
    this.zipFile.on("error", (error: unknown) => {
      this.backgroundError = asKohoZipError(error);
    });
  }

  get entries(): readonly KohoZipEntry[] {
    this.assertOpen();
    return this.entryList;
  }

  get summary(): KohoZipSummary {
    this.assertOpen();
    return this.packageSummary;
  }

  async readEntryBytes(entryId: number): Promise<Uint8Array> {
    this.assertOpen();
    if (this.readInProgress) {
      throw new KohoZipError("concurrent_read_forbidden");
    }
    if (!Number.isSafeInteger(entryId)) {
      throw new KohoZipError("entry_not_found");
    }

    const publicEntry = this.entryList[entryId];
    const yauzlEntry = this.yauzlEntries.get(entryId);
    if (publicEntry === undefined || yauzlEntry === undefined) {
      throw new KohoZipError("entry_not_found");
    }
    if (publicEntry.isDirectory) {
      throw new KohoZipError("directory_entry");
    }
    if (publicEntry.encrypted) {
      throw new KohoZipError("encrypted_entry");
    }
    if (publicEntry.compressionMethod !== 0 && publicEntry.compressionMethod !== 8) {
      throw new KohoZipError("unsupported_compression");
    }
    const remainingReadBytes =
      this.limits.maxTotalReadUncompressedBytes -
      this.totalReadUncompressedBytes;
    if (
      publicEntry.uncompressedSize > remainingReadBytes ||
      (remainingReadBytes === 0 && publicEntry.compressedSize > 0)
    ) {
      throw new KohoZipError("entry_read_limit");
    }

    this.readInProgress = true;
    const readStartTotal = this.totalReadUncompressedBytes;
    try {
      await this.validateSelectedLocalHeader(yauzlEntry);
      // Omitting options is intentional: yauzl 3.4 decodes stored/deflate data
      // and applies validateEntrySizes only on this default path.
      const stream = await this.zipFile.openReadStreamPromise(yauzlEntry);
      this.activeStream = stream;
      return await this.collectEntryBytes(stream, publicEntry.uncompressedSize);
    } catch (error) {
      if (this.closed) throw new KohoZipError("reader_closed");
      const observedMinimum = extractTooManyObservedBytes(error);
      if (observedMinimum !== null) {
        this.totalReadUncompressedBytes = Math.min(
          this.limits.maxTotalReadUncompressedBytes,
          Math.max(
            this.totalReadUncompressedBytes,
            readStartTotal + observedMinimum,
          ),
        );
      }
      throw mapReadError(error, readStartTotal, this.limits);
    } finally {
      this.activeStream = null;
      this.readInProgress = false;
    }
  }

  close(): Promise<void> {
    if (this.closePromise !== null) return this.closePromise;
    this.closed = true;
    this.activeStream?.destroy();
    if (this.zipFile.isOpen) this.zipFile.close();
    this.closePromise = this.source.close();
    return this.closePromise;
  }

  private async collectEntryBytes(
    stream: Readable,
    declaredUncompressedSize: number,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let entryBytes = 0;

    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const nextEntryBytes = checkedAdd(entryBytes, chunk.byteLength);
      if (nextEntryBytes > this.limits.maxEntryUncompressedBytes) {
        stream.destroy();
        throw new KohoZipError("entry_read_limit");
      }
      const nextTotalBytes = checkedAdd(
        this.totalReadUncompressedBytes,
        chunk.byteLength,
      );
      if (nextTotalBytes > this.limits.maxTotalReadUncompressedBytes) {
        this.totalReadUncompressedBytes =
          this.limits.maxTotalReadUncompressedBytes;
        stream.destroy();
        throw new KohoZipError("entry_read_limit");
      }

      entryBytes = nextEntryBytes;
      this.totalReadUncompressedBytes = nextTotalBytes;
      chunks.push(chunk);
    }

    if (entryBytes !== declaredUncompressedSize) {
      throw new KohoZipError("entry_size_mismatch");
    }
    if (chunks.length === 0) return Buffer.alloc(0);
    if (chunks.length === 1) return chunks[0];
    return Buffer.concat(chunks, entryBytes);
  }

  private assertOpen(): void {
    if (this.closed) throw new KohoZipError("reader_closed");
    if (this.backgroundError !== null) throw this.backgroundError;
  }

  private async validateSelectedLocalHeader(entry: Entry): Promise<void> {
    const header = await this.zipFile.readLocalFileHeaderPromise(entry);
    if (
      header.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
      header.compressionMethod !== entry.compressionMethod ||
      !header.fileName.equals(entry.fileNameRaw)
    ) {
      throw new KohoZipError("invalid_zip");
    }
    if ((entry.generalPurposeBitFlag & 0x08) === 0) {
      if (header.crc32 !== entry.crc32) {
        throw new KohoZipError("invalid_zip");
      }
      const localSizes = readLocalHeaderSizes(header);
      if (
        localSizes.compressedSize !== entry.compressedSize ||
        localSizes.uncompressedSize !== entry.uncompressedSize
      ) {
        throw new KohoZipError("entry_size_mismatch");
      }
    }

    let nextBoundary = this.centralDirectoryOffset;
    for (const candidate of this.yauzlEntries.values()) {
      if (
        candidate.relativeOffsetOfLocalHeader >
          entry.relativeOffsetOfLocalHeader &&
        candidate.relativeOffsetOfLocalHeader < nextBoundary
      ) {
        nextBoundary = candidate.relativeOffsetOfLocalHeader;
      }
    }
    const dataEnd = checkedAdd(header.fileDataStart, entry.compressedSize);
    if (header.fileDataStart > nextBoundary || dataEnd > nextBoundary) {
      throw new KohoZipError("invalid_zip");
    }
  }
}

function readLocalHeaderSizes(header: LocalFileHeader): {
  readonly compressedSize: number;
  readonly uncompressedSize: number;
} {
  const uint32Max = 0xffffffff;
  if (
    header.compressedSize !== uint32Max &&
    header.uncompressedSize !== uint32Max
  ) {
    return {
      compressedSize: header.compressedSize,
      uncompressedSize: header.uncompressedSize,
    };
  }

  const zip64Extra = findLocalZip64Extra(header.extraField);
  if (zip64Extra === null) {
    return {
      compressedSize: header.compressedSize,
      uncompressedSize: header.uncompressedSize,
    };
  }

  let cursor = 0;
  const takeUInt64 = (): number => {
    if (cursor + 8 > zip64Extra.byteLength) {
      throw new KohoZipError("invalid_zip");
    }
    const value = zip64Extra.readBigUInt64LE(cursor);
    cursor += 8;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new KohoZipError("zip64_value_unsafe");
    }
    return Number(value);
  };

  const uncompressedSize =
    header.uncompressedSize === uint32Max
      ? takeUInt64()
      : header.uncompressedSize;
  const compressedSize =
    header.compressedSize === uint32Max
      ? takeUInt64()
      : header.compressedSize;
  return { compressedSize, uncompressedSize };
}

function findLocalZip64Extra(extraFields: Buffer): Buffer | null {
  let cursor = 0;
  let zip64Extra: Buffer | null = null;
  while (cursor < extraFields.byteLength) {
    if (cursor + 4 > extraFields.byteLength) {
      throw new KohoZipError("invalid_zip");
    }
    const fieldId = extraFields.readUInt16LE(cursor);
    const fieldSize = extraFields.readUInt16LE(cursor + 2);
    const dataStart = cursor + 4;
    const dataEnd = dataStart + fieldSize;
    if (dataEnd > extraFields.byteLength) {
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

function validateEntryNumbers(entry: Entry, centralDirectoryOffset: number): void {
  const values = [
    entry.compressedSize,
    entry.uncompressedSize,
    entry.relativeOffsetOfLocalHeader,
    entry.fileNameLength,
    entry.extraFieldLength,
    entry.fileCommentLength,
  ];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    entry.relativeOffsetOfLocalHeader >= centralDirectoryOffset
  ) {
    const unsafeZip64 = values.some((value) => value > Number.MAX_SAFE_INTEGER);
    throw new KohoZipError(unsafeZip64 ? "zip64_value_unsafe" : "invalid_zip");
  }
}

function addWithinLimit(
  total: number,
  value: number,
  limit: number,
  code: "total_compressed_limit" | "total_uncompressed_limit",
): number {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(value) || value < 0) {
    throw new KohoZipError("zip64_value_unsafe");
  }
  if (value > limit || total > limit - value) {
    throw new KohoZipError(code);
  }
  return total + value;
}

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new KohoZipError("entry_read_limit");
  }
  return result;
}

function mapReadError(
  error: unknown,
  readStartTotal: number,
  limits: KohoZipLimits,
): KohoZipError {
  const observedMinimum = extractTooManyObservedBytes(error);
  if (observedMinimum !== null) {
    if (
      (observedMinimum > limits.maxEntryUncompressedBytes ||
        readStartTotal >
          limits.maxTotalReadUncompressedBytes - observedMinimum)
    ) {
      return new KohoZipError("entry_read_limit");
    }
  }
  return asKohoZipError(error);
}

function extractTooManyObservedBytes(error: unknown): number | null {
  let message = "";
  try {
    message = error instanceof Error ? error.message : "";
  } catch {
    return null;
  }
  const match = /too many bytes in the stream\. expected \d+\. got at least (\d+)/.exec(
    message,
  );
  if (match === null) return null;
  const observed = Number(match[1]);
  return Number.isSafeInteger(observed) && observed >= 0 ? observed : null;
}

function snapshotLimits(limits: KohoZipLimits): KohoZipLimits {
  if (limits === null || typeof limits !== "object") {
    throw new KohoZipError("invalid_limits");
  }
  return Object.freeze({
    maxSourceBytes: limits.maxSourceBytes,
    maxCentralDirectoryBytes: limits.maxCentralDirectoryBytes,
    maxEntries: limits.maxEntries,
    maxTotalCompressedBytes: limits.maxTotalCompressedBytes,
    maxTotalUncompressedBytes: limits.maxTotalUncompressedBytes,
    maxEntryCompressedBytes: limits.maxEntryCompressedBytes,
    maxEntryUncompressedBytes: limits.maxEntryUncompressedBytes,
    maxTotalReadUncompressedBytes: limits.maxTotalReadUncompressedBytes,
  });
}

function snapshotSource(source: KohoZipSource): KohoZipSource {
  if (source === null || typeof source !== "object") {
    throw new KohoZipError("source_invalid");
  }
  const sourceType = source.type;
  if (sourceType === "buffer") {
    const bytes = source.bytes;
    const sourceName = source.sourceName;
    return Object.freeze({
      type: "buffer",
      bytes,
      ...(sourceName === undefined ? {} : { sourceName }),
    });
  }
  if (sourceType === "file") {
    return Object.freeze({ type: "file", path: source.path });
  }
  throw new KohoZipError("source_invalid");
}

function createRoleCounts(): Record<KohoZipEntryRole, number> {
  return {
    directory: 0,
    xml: 0,
    csv: 0,
    schema: 0,
    image: 0,
    other: 0,
  };
}

function createCandidateCounts(): Record<KohoZipPathCandidate, number> {
  return {
    primary_xml: 0,
    nested_xml: 0,
    none: 0,
  };
}

function createStrongEncryptionMaskingStream(
  sourceStream: Readable,
  start: number,
  strongEncryptionEntries: readonly StrongEncryptionEntryObservation[],
): Readable {
  async function* maskedChunks(): AsyncGenerator<Buffer> {
    let absoluteOffset = start;
    try {
      for await (const value of sourceStream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const chunkEnd = absoluteOffset + chunk.byteLength;
        let headerIndex = lowerBoundStrongEntry(
          strongEncryptionEntries,
          absoluteOffset - 11,
        );
        let output = chunk;
        while (headerIndex < strongEncryptionEntries.length) {
          const strongEntry = strongEncryptionEntries[headerIndex];
          const flagByteOffset = strongEntry.headerOffset + 8;
          if (strongEntry.headerOffset >= chunkEnd) break;
          if (
            flagByteOffset >= absoluteOffset &&
            flagByteOffset < chunkEnd
          ) {
            if (output === chunk) output = Buffer.from(chunk);
            output[flagByteOffset - absoluteOffset] &= ~0x40;
          }
          if (strongEntry.compressionMethod === 0) {
            output = replaceByteInChunk(
              output,
              chunk,
              absoluteOffset,
              chunkEnd,
              strongEntry.headerOffset + 10,
              99,
            );
            output = replaceByteInChunk(
              output,
              chunk,
              absoluteOffset,
              chunkEnd,
              strongEntry.headerOffset + 11,
              0,
            );
          }
          headerIndex += 1;
        }
        absoluteOffset = chunkEnd;
        yield output;
      }
    } finally {
      if (!sourceStream.destroyed) sourceStream.destroy();
    }
  }

  return Readable.from(maskedChunks(), { objectMode: false });
}

function lowerBoundStrongEntry(
  entries: readonly StrongEncryptionEntryObservation[],
  minimum: number,
): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (entries[middle].headerOffset < minimum) low = middle + 1;
    else high = middle;
  }
  return low;
}

function replaceByteInChunk(
  output: Buffer,
  original: Buffer,
  chunkStart: number,
  chunkEnd: number,
  absoluteByteOffset: number,
  value: number,
): Buffer {
  if (absoluteByteOffset < chunkStart || absoluteByteOffset >= chunkEnd) {
    return output;
  }
  const writable = output === original ? Buffer.from(original) : output;
  writable[absoluteByteOffset - chunkStart] = value;
  return writable;
}
