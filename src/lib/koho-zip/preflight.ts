import { asKohoZipError, KohoZipError } from "./errors";
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
  eocdTailBytesRead: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
  declaredEntryCount: number;
  observedEntryCount: number;
  totalDeclaredCompressedBytes: number;
  totalDeclaredUncompressedBytes: number;
  strongEncryptionEntries: readonly StrongEncryptionEntryObservation[];
  yauzlOpeningRecord: YauzlOpeningRecord;
}

export interface YauzlOpeningRecord {
  readonly eocdOffset: number;
  readonly eocdBytes: Buffer;
  readonly locatorOffset: number | null;
  readonly locatorBytes: Buffer | null;
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

interface EocdCandidate {
  readonly offset: number;
  readonly bytes: Buffer;
}

interface Zip64Locator {
  readonly offset: number;
  readonly bytes: Buffer;
}

interface CachedSourceRange {
  readonly start: number;
  readonly end: number;
  readonly bytes: Buffer;
}

interface StrongEncryptionNode {
  readonly value: StrongEncryptionEntryObservation;
  readonly previous: StrongEncryptionNode | null;
}

interface CentralDirectoryState {
  readonly cursor: number;
  readonly count: number;
  readonly totalCompressedBytes: number;
  readonly totalUncompressedBytes: number;
  readonly sawDigitalSignature: boolean;
  readonly strongEncryptionTail: StrongEncryptionNode | null;
}

interface CentralDirectoryScan {
  readonly states: CentralDirectoryState[];
  readonly records: Map<number, Promise<ParsedCentralDirectoryRecord>>;
  readonly validatedEntries: Map<
    number,
    Promise<ValidatedCentralDirectoryRecord>
  >;
}

type ParsedCentralDirectoryRecord =
  | {
      readonly kind: "digital_signature";
      readonly recordEnd: number;
    }
  | {
      readonly kind: "entry";
      readonly recordEnd: number;
      readonly header: Buffer;
    };

interface ValidatedCentralDirectoryRecord {
  readonly compressionMethod: number;
  readonly entry: ValidatedCentralDirectoryEntry;
}

interface MetadataReadContext {
  readonly source: InternalZipSource;
  readonly metadataRanges: UniqueByteRangeCounter;
  readonly targetedMetadataRanges: UniqueByteRangeCounter;
  readonly tailOffset: number;
  readonly tail: Buffer;
  readonly sourceCache: CachedSourceRange[];
  readonly centralDirectoryScans: Map<number, CentralDirectoryScan>;
  candidateValidationWorkBytes: number;
}

interface ValidatedEocdCandidate {
  readonly zip64: boolean;
  readonly commentLength: number;
  readonly centralDirectoryOffset: number;
  readonly centralDirectorySize: number;
  readonly declaredEntryCount: number;
  readonly observedEntryCount: number;
  readonly totalDeclaredCompressedBytes: number;
  readonly totalDeclaredUncompressedBytes: number;
  readonly strongEncryptionEntries: readonly StrongEncryptionEntryObservation[];
  readonly yauzlOpeningRecord: YauzlOpeningRecord;
}

export async function preflightKohoZip(
  source: InternalZipSource,
  limits: KohoZipLimits,
  metadataRanges: UniqueByteRangeCounter,
  targetedMetadataRanges: UniqueByteRangeCounter,
): Promise<KohoZipPreflight> {
  if (source.size < EOCD_MIN_SIZE) {
    throw new KohoZipError("invalid_zip");
  }

  const tailLength = Math.min(
    source.size,
    EOCD_MIN_SIZE + MAX_COMMENT_SIZE,
  );
  const tailOffset = source.size - tailLength;
  metadataRanges.add(tailOffset, source.size);
  const tail = await readSourceExact(source, tailOffset, tailLength);
  const reads: MetadataReadContext = {
    source,
    metadataRanges,
    targetedMetadataRanges,
    tailOffset,
    tail,
    sourceCache: [],
    centralDirectoryScans: new Map(),
    candidateValidationWorkBytes: 0,
  };
  const candidates = findEocdCandidates(tail, tailOffset);
  if (candidates.length === 0) {
    throw new KohoZipError("invalid_zip");
  }

  const validated: ValidatedEocdCandidate[] = [];
  const blockers: KohoZipError[] = [];
  for (const candidate of candidates) {
    let result: ValidatedEocdCandidate;
    try {
      result = await validateEocdCandidate(reads, limits, candidate);
    } catch (error) {
      const stableError = asKohoZipError(error);
      if (stableError.code === "invalid_zip") continue;
      if (stableError.code === "source_invalid") throw stableError;
      blockers.push(stableError);
      if (validated.length > 0 || blockers.length > 1) {
        throw new KohoZipError("ambiguous_eocd");
      }
      continue;
    }
    validated.push(result);
    if (validated.length > 1 || blockers.length > 0) {
      throw new KohoZipError("ambiguous_eocd");
    }
  }

  if (validated.length === 1) {
    if (blockers.length > 0) throw new KohoZipError("ambiguous_eocd");
  } else if (blockers.length === 1) {
    throw blockers[0];
  } else if (blockers.length > 1) {
    throw new KohoZipError("ambiguous_eocd");
  } else {
    throw new KohoZipError("invalid_zip");
  }

  return {
    ...validated[0],
    eocdTailBytesRead: tailLength,
  };
}

async function validateEocdCandidate(
  reads: MetadataReadContext,
  limits: KohoZipLimits,
  candidate: EocdCandidate,
): Promise<ValidatedEocdCandidate> {
  const eocdOffset = candidate.offset;
  const eocd = parseEocd(candidate.bytes);
  const locator = await readZip64Locator(reads, eocdOffset);
  const hasZip64Locator = locator !== null;
  let values: EocdValues | Zip64Values = eocd;
  let metadataStart = eocdOffset;
  let locatorDisk = 0;
  let totalDisks = 1;
  if (locator !== null) {
    locatorDisk = locator.bytes.readUInt32LE(4);
    const zip64Offset = readSafeUInt64(locator.bytes, 8);
    totalDisks = locator.bytes.readUInt32LE(16);

    const zip64Buffer = await readMetadataExact(
      reads,
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
    const recordEnd = safeAdd(
      zip64Offset,
      safeAdd(12, recordPayloadSize, true),
      true,
    );
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

  const centralDirectoryEnd = safeAdd(
    values.centralDirectoryOffset,
    values.centralDirectorySize,
    hasZip64Locator,
  );
  if (
    centralDirectoryEnd > reads.source.size ||
    centralDirectoryEnd !== metadataStart
  ) {
    throw new KohoZipError("invalid_zip");
  }
  if (
    values.entryCount >
    Math.floor(values.centralDirectorySize / CENTRAL_DIRECTORY_HEADER_SIZE)
  ) {
    throw new KohoZipError("invalid_zip");
  }
  if (
    locatorDisk !== 0 ||
    totalDisks !== 1 ||
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

  const observation = await inspectCentralDirectoryEntries(
    reads,
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
    yauzlOpeningRecord: Object.freeze({
      eocdOffset,
      eocdBytes: Buffer.from(candidate.bytes),
      locatorOffset: locator?.offset ?? null,
      locatorBytes: locator === null ? null : Buffer.from(locator.bytes),
    }),
  };
}

function findEocdCandidates(
  tail: Buffer,
  tailOffset: number,
): readonly EocdCandidate[] {
  const candidates: EocdCandidate[] = [];
  for (let offset = 0; offset <= tail.length - EOCD_MIN_SIZE; offset += 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (commentLength !== tail.length - offset - EOCD_MIN_SIZE) continue;
    candidates.push(
      Object.freeze({
        offset: tailOffset + offset,
        bytes: Buffer.from(tail.subarray(offset, offset + EOCD_MIN_SIZE)),
      }),
    );
  }
  return Object.freeze(candidates);
}

async function readZip64Locator(
  reads: MetadataReadContext,
  eocdOffset: number,
): Promise<Zip64Locator | null> {
  if (eocdOffset < ZIP64_LOCATOR_SIZE) return null;

  const locatorOffset = eocdOffset - ZIP64_LOCATOR_SIZE;
  const signature = await readMetadataExact(reads, locatorOffset, 4);
  if (signature.readUInt32LE(0) !== ZIP64_LOCATOR_SIGNATURE) return null;
  const remainder = await readMetadataExact(
    reads,
    locatorOffset + 4,
    ZIP64_LOCATOR_SIZE - 4,
  );
  return {
    offset: locatorOffset,
    bytes: Buffer.concat([signature, remainder], ZIP64_LOCATOR_SIZE),
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
  reads: MetadataReadContext,
  start: number,
  end: number,
  limits: KohoZipLimits,
): Promise<CentralDirectoryObservation> {
  let scan = reads.centralDirectoryScans.get(start);
  if (scan === undefined) {
    scan = {
      states: [
        {
          cursor: start,
          count: 0,
          totalCompressedBytes: 0,
          totalUncompressedBytes: 0,
          sawDigitalSignature: false,
          strongEncryptionTail: null,
        },
      ],
      records: new Map(),
      validatedEntries: new Map(),
    };
    reads.centralDirectoryScans.set(start, scan);
  }

  let state = findCentralDirectoryState(scan.states, end);
  while (state.cursor < end) {
    if (state.sawDigitalSignature) throw new KohoZipError("invalid_zip");

    const signatureBuffer = await readMetadataExact(reads, state.cursor, 4);
    const signature = signatureBuffer.readUInt32LE(0);
    if (
      signature !== CENTRAL_DIRECTORY_SIGNATURE &&
      signature !== CENTRAL_DIRECTORY_DIGITAL_SIGNATURE
    ) {
      throw new KohoZipError("invalid_zip");
    }
    const record = await readCentralDirectoryRecord(
      reads,
      scan,
      start,
      state.cursor,
      signatureBuffer,
    );
    const envelopeWorkBytes =
      record.kind === "entry" ? CENTRAL_DIRECTORY_HEADER_SIZE : 6;
    addCandidateValidationWork(
      reads,
      envelopeWorkBytes,
      limits.maxCentralDirectoryBytes,
    );
    if (record.recordEnd > end) throw new KohoZipError("invalid_zip");
    addCandidateValidationWork(
      reads,
      record.recordEnd - state.cursor - envelopeWorkBytes,
      limits.maxCentralDirectoryBytes,
    );
    if (record.kind === "entry" && state.count >= limits.maxEntries) {
      throw new KohoZipError("entry_count_limit");
    }

    let nextState: CentralDirectoryState;
    if (record.kind === "digital_signature") {
      nextState = {
        ...state,
        cursor: record.recordEnd,
        sawDigitalSignature: true,
      };
    } else {
      const validatedRecord = await validateCentralDirectoryRecord(
        reads,
        scan,
        start,
        state.cursor,
        record,
      );
      const totalCompressedBytes = addDeclaredSize(
        state.totalCompressedBytes,
        validatedRecord.entry.compressedSize,
        limits.maxEntryCompressedBytes,
        limits.maxTotalCompressedBytes,
        "entry_compressed_limit",
        "total_compressed_limit",
      );
      const totalUncompressedBytes = addDeclaredSize(
        state.totalUncompressedBytes,
        validatedRecord.entry.uncompressedSize,
        limits.maxEntryUncompressedBytes,
        limits.maxTotalUncompressedBytes,
        "entry_uncompressed_limit",
        "total_uncompressed_limit",
      );
      const count = state.count + 1;
      if (!Number.isSafeInteger(count) || count > limits.maxEntries) {
        throw new KohoZipError("entry_count_limit");
      }
      nextState = {
        cursor: record.recordEnd,
        count,
        totalCompressedBytes,
        totalUncompressedBytes,
        sawDigitalSignature: false,
        strongEncryptionTail: validatedRecord.entry.strongEncryption
          ? {
              value: Object.freeze({
                entryId: state.count,
                headerOffset: state.cursor,
                compressionMethod: validatedRecord.compressionMethod,
              }),
              previous: state.strongEncryptionTail,
            }
          : state.strongEncryptionTail,
      };
    }
    const existingState = findExactCentralDirectoryState(
      scan.states,
      nextState.cursor,
    );
    if (existingState === null) {
      insertCentralDirectoryState(scan.states, nextState);
      state = nextState;
    } else {
      state = existingState;
    }
  }

  return {
    count: state.count,
    totalCompressedBytes: state.totalCompressedBytes,
    totalUncompressedBytes: state.totalUncompressedBytes,
    strongEncryptionEntries: materializeStrongEncryptionEntries(
      state.strongEncryptionTail,
    ),
  };
}

async function readCentralDirectoryRecord(
  reads: MetadataReadContext,
  scan: CentralDirectoryScan,
  centralDirectoryStart: number,
  cursor: number,
  signatureBuffer: Buffer,
): Promise<ParsedCentralDirectoryRecord> {
  let record = scan.records.get(cursor);
  if (record === undefined) {
    record = parseCentralDirectoryRecord(
      reads,
      centralDirectoryStart,
      cursor,
      signatureBuffer,
    );
    scan.records.set(cursor, record);
  }
  return record;
}

async function parseCentralDirectoryRecord(
  reads: MetadataReadContext,
  centralDirectoryStart: number,
  cursor: number,
  signatureBuffer: Buffer,
): Promise<ParsedCentralDirectoryRecord> {
  const signature = signatureBuffer.readUInt32LE(0);
  if (signature === CENTRAL_DIRECTORY_DIGITAL_SIGNATURE) {
    const sizeBytes = await readMetadataExact(reads, cursor + 4, 2);
    return {
      kind: "digital_signature",
      recordEnd: safeAdd(cursor, 6 + sizeBytes.readUInt16LE(0), false),
    };
  }
  if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
    throw new KohoZipError("invalid_zip");
  }

  const header = Buffer.concat(
    [
      signatureBuffer,
      await readMetadataExact(
        reads,
        cursor + 4,
        CENTRAL_DIRECTORY_HEADER_SIZE - 4,
      ),
    ],
    CENTRAL_DIRECTORY_HEADER_SIZE,
  );
  const variableSize =
    header.readUInt16LE(28) +
    header.readUInt16LE(30) +
    header.readUInt16LE(32);
  const recordEnd = safeAdd(
    cursor,
    CENTRAL_DIRECTORY_HEADER_SIZE + variableSize,
    false,
  );
  if (recordEnd > reads.source.size) throw new KohoZipError("invalid_zip");
  return {
    kind: "entry",
    recordEnd,
    header,
  };
}

async function validateCentralDirectoryRecord(
  reads: MetadataReadContext,
  scan: CentralDirectoryScan,
  centralDirectoryStart: number,
  cursor: number,
  record: Extract<ParsedCentralDirectoryRecord, { kind: "entry" }>,
): Promise<ValidatedCentralDirectoryRecord> {
  let validated = scan.validatedEntries.get(cursor);
  if (validated === undefined) {
    validated = (async () => {
      const fileNameLength = record.header.readUInt16LE(28);
      const extraFieldLength = record.header.readUInt16LE(30);
      const extraFields =
        extraFieldLength === 0
          ? Buffer.alloc(0)
          : await readMetadataExact(
              reads,
              cursor + CENTRAL_DIRECTORY_HEADER_SIZE + fileNameLength,
              extraFieldLength,
            );
      return {
        compressionMethod: record.header.readUInt16LE(10),
        entry: validateCentralDirectoryEntry(
          record.header,
          extraFields,
          centralDirectoryStart,
        ),
      };
    })();
    scan.validatedEntries.set(cursor, validated);
  }
  return validated;
}

function findCentralDirectoryState(
  states: readonly CentralDirectoryState[],
  end: number,
): CentralDirectoryState {
  let low = 0;
  let high = states.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (states[middle].cursor <= end) low = middle + 1;
    else high = middle;
  }
  return states[Math.max(0, low - 1)];
}

function findExactCentralDirectoryState(
  states: readonly CentralDirectoryState[],
  cursor: number,
): CentralDirectoryState | null {
  const state = findCentralDirectoryState(states, cursor);
  return state.cursor === cursor ? state : null;
}

function insertCentralDirectoryState(
  states: CentralDirectoryState[],
  addition: CentralDirectoryState,
): void {
  let low = 0;
  let high = states.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (states[middle].cursor < addition.cursor) low = middle + 1;
    else high = middle;
  }
  states.splice(low, 0, addition);
}

function materializeStrongEncryptionEntries(
  tail: StrongEncryptionNode | null,
): readonly StrongEncryptionEntryObservation[] {
  const entries: StrongEncryptionEntryObservation[] = [];
  for (let node = tail; node !== null; node = node.previous) {
    entries.push(node.value);
  }
  entries.reverse();
  return Object.freeze(entries);
}

function addCandidateValidationWork(
  reads: MetadataReadContext,
  amount: number,
  limit: number,
): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    reads.candidateValidationWorkBytes > limit - amount
  ) {
    throw new KohoZipError("central_directory_too_large");
  }
  reads.candidateValidationWorkBytes += amount;
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

async function readMetadataExact(
  reads: MetadataReadContext,
  start: number,
  length: number,
): Promise<Buffer> {
  const end = safeAdd(start, length, false);
  if (length <= 0 || end > reads.source.size) {
    throw new KohoZipError("invalid_zip");
  }

  if (start >= reads.tailOffset) {
    return Buffer.from(
      reads.tail.subarray(start - reads.tailOffset, end - reads.tailOffset),
    );
  }

  const sourceEnd = Math.min(end, reads.tailOffset);
  const sourceBytes = await readCachedSourceRange(reads, start, sourceEnd);
  if (end <= reads.tailOffset) return sourceBytes;

  return Buffer.concat(
    [
      sourceBytes,
      reads.tail.subarray(0, end - reads.tailOffset),
    ],
    length,
  );
}

async function readCachedSourceRange(
  reads: MetadataReadContext,
  start: number,
  end: number,
): Promise<Buffer> {
  const gaps: Array<{ start: number; end: number }> = [];
  let cursor = start;
  const firstCachedIndex = findFirstRangeEndingAfter(
    reads.sourceCache,
    start,
  );
  for (
    let index = firstCachedIndex;
    index < reads.sourceCache.length;
    index += 1
  ) {
    const cached = reads.sourceCache[index];
    if (cached.start >= end) break;
    if (cached.start > cursor) {
      gaps.push({ start: cursor, end: Math.min(cached.start, end) });
    }
    cursor = Math.max(cursor, Math.min(cached.end, end));
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push({ start: cursor, end });

  for (const gap of gaps) {
    reads.metadataRanges.add(gap.start, gap.end);
    reads.targetedMetadataRanges.add(gap.start, gap.end);
  }

  const additions: CachedSourceRange[] = [];
  for (const gap of gaps) {
    additions.push({
      ...gap,
      bytes: await readSourceExact(
        reads.source,
        gap.start,
        gap.end - gap.start,
      ),
    });
  }
  if (additions.length > 0) {
    for (const addition of additions) {
      insertCachedRange(reads.sourceCache, addition);
    }
  }

  const output = Buffer.allocUnsafe(end - start);
  let outputOffset = 0;
  const copyStartIndex = findFirstRangeEndingAfter(reads.sourceCache, start);
  for (
    let index = copyStartIndex;
    index < reads.sourceCache.length;
    index += 1
  ) {
    const cached = reads.sourceCache[index];
    if (cached.start >= end) break;
    const copyStart = Math.max(start, cached.start);
    const copyEnd = Math.min(end, cached.end);
    if (copyStart >= copyEnd) continue;
    cached.bytes.copy(
      output,
      copyStart - start,
      copyStart - cached.start,
      copyEnd - cached.start,
    );
    outputOffset += copyEnd - copyStart;
  }
  if (outputOffset !== end - start) {
    throw new KohoZipError("source_invalid");
  }
  return output;
}

function findFirstRangeEndingAfter(
  ranges: readonly CachedSourceRange[],
  position: number,
): number {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].end <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

function insertCachedRange(
  ranges: CachedSourceRange[],
  addition: CachedSourceRange,
): void {
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ranges[middle].start < addition.start) low = middle + 1;
    else high = middle;
  }
  ranges.splice(low, 0, addition);
}

async function readSourceExact(
  source: InternalZipSource,
  start: number,
  length: number,
): Promise<Buffer> {
  const end = safeAdd(start, length, false);
  if (length <= 0 || end > source.size) {
    throw new KohoZipError("invalid_zip");
  }
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
