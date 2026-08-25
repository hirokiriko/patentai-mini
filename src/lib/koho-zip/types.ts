export type KohoZipSource =
  | { type: "file"; path: string }
  | { type: "buffer"; bytes: Uint8Array; sourceName?: string };

export interface KohoZipLimits {
  maxSourceBytes: number;
  maxCentralDirectoryBytes: number;
  maxEntries: number;
  maxTotalCompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxEntryCompressedBytes: number;
  maxEntryUncompressedBytes: number;
  maxTotalReadUncompressedBytes: number;
}

export interface KohoZipOpenInput {
  source: KohoZipSource;
  limits: KohoZipLimits;
}

export type KohoZipErrorCode =
  | "invalid_limits"
  | "source_invalid"
  | "source_too_large"
  | "invalid_zip"
  | "zip64_value_unsafe"
  | "multi_disk_unsupported"
  | "central_directory_too_large"
  | "entry_count_limit"
  | "total_compressed_limit"
  | "total_uncompressed_limit"
  | "entry_compressed_limit"
  | "entry_uncompressed_limit"
  | "unsafe_entry_path"
  | "duplicate_entry_path"
  | "encrypted_entry"
  | "unsupported_compression"
  | "entry_read_limit"
  | "entry_size_mismatch"
  | "concurrent_read_forbidden"
  | "reader_closed"
  | "entry_not_found"
  | "directory_entry";

export type KohoZipEntryRole =
  | "directory"
  | "xml"
  | "csv"
  | "schema"
  | "image"
  | "other";

export type KohoZipPathCandidate =
  | "primary_xml"
  | "nested_xml"
  | "none";

export interface KohoZipEntryIssue {
  readonly code: "encrypted_entry" | "unsupported_compression";
  readonly message: string;
}

export interface KohoZipEntry {
  readonly id: number;
  readonly rawFileNameBase64: string;
  readonly decodedPath: string;
  readonly normalizedPath: string;
  readonly isDirectory: boolean;
  readonly compressionMethod: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly crc32: number;
  readonly encrypted: boolean;
  readonly role: KohoZipEntryRole;
  readonly pathCandidate: KohoZipPathCandidate;
  readonly canRead: boolean;
  readonly issues: readonly KohoZipEntryIssue[];
}

export interface KohoZipSummary {
  readonly sourceType: KohoZipSource["type"];
  readonly sourceName: string | null;
  readonly sourceSize: number;
  readonly zip64: boolean;
  readonly commentLength: number;
  readonly centralDirectoryOffset: number;
  readonly declaredCentralDirectorySize: number;
  readonly metadataBytesRead: number;
  readonly declaredEntryCount: number;
  readonly observedEntryCount: number;
  readonly totalDeclaredCompressedBytes: number;
  readonly totalDeclaredUncompressedBytes: number;
  readonly roleCounts: Readonly<Record<KohoZipEntryRole, number>>;
  readonly candidateCounts: Readonly<Record<KohoZipPathCandidate, number>>;
  readonly encryptedEntryCount: number;
  readonly unsupportedCompressionEntryCount: number;
}

export interface KohoZipReader {
  readonly entries: readonly KohoZipEntry[];
  readonly summary: KohoZipSummary;
  readEntryBytes(entryId: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
