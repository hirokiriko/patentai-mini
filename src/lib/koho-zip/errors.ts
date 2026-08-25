import type { KohoZipErrorCode } from "./types";

const PUBLIC_MESSAGES: Record<KohoZipErrorCode, string> = {
  invalid_limits: "ZIP limits are invalid",
  source_invalid: "ZIP source is invalid or unavailable",
  source_too_large: "ZIP source exceeds the configured limit",
  invalid_zip: "ZIP metadata or entry data is invalid",
  zip64_value_unsafe: "ZIP64 metadata contains an unsafe integer value",
  multi_disk_unsupported: "Multi-disk ZIP archives are not supported",
  central_directory_too_large:
    "ZIP central-directory metadata exceeds the configured limit",
  entry_count_limit: "ZIP entry count exceeds the configured limit",
  total_compressed_limit:
    "ZIP declared compressed bytes exceed the configured limit",
  total_uncompressed_limit:
    "ZIP declared uncompressed bytes exceed the configured limit",
  entry_compressed_limit:
    "ZIP entry declared compressed bytes exceed the configured limit",
  entry_uncompressed_limit:
    "ZIP entry declared uncompressed bytes exceed the configured limit",
  unsafe_entry_path: "ZIP entry path is unsafe",
  duplicate_entry_path: "ZIP contains duplicate normalized entry paths",
  encrypted_entry: "Encrypted ZIP entries cannot be read",
  unsupported_compression: "ZIP entry compression method is not supported",
  entry_read_limit: "ZIP entry read exceeds the configured limit",
  entry_size_mismatch: "ZIP entry size does not match its metadata",
  concurrent_read_forbidden: "Concurrent ZIP entry reads are not allowed",
  reader_closed: "ZIP reader is closed",
  entry_not_found: "ZIP entry ID does not exist",
  directory_entry: "ZIP directory entries cannot be read",
};

export class KohoZipError extends Error {
  readonly code: KohoZipErrorCode;

  constructor(code: KohoZipErrorCode) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "KohoZipError";
    this.code = code;
  }
}

export function asKohoZipError(error: unknown): KohoZipError {
  if (error instanceof KohoZipError) {
    return error;
  }

  const message = error instanceof Error ? error.message : "";
  if (
    message.startsWith("absolute path:") ||
    message.startsWith("invalid relative path:") ||
    message.startsWith("invalid characters in fileName:")
  ) {
    return new KohoZipError("unsafe_entry_path");
  }
  if (message.includes("multi-disk zip files are not supported")) {
    return new KohoZipError("multi_disk_unsupported");
  }
  if (
    message.includes("compressed/uncompressed size mismatch") ||
    message.includes("too many bytes in the stream") ||
    message.includes("not enough bytes in the stream")
  ) {
    return new KohoZipError("entry_size_mismatch");
  }
  if (message.includes("encrypted")) {
    return new KohoZipError("encrypted_entry");
  }
  if (message.includes("unsupported compression method")) {
    return new KohoZipError("unsupported_compression");
  }

  return new KohoZipError("invalid_zip");
}
