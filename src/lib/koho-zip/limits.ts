import { KohoZipError } from "./errors";
import type { KohoZipLimits } from "./types";

const LIMIT_KEYS: readonly (keyof KohoZipLimits)[] = [
  "maxSourceBytes",
  "maxCentralDirectoryBytes",
  "maxEntries",
  "maxTotalCompressedBytes",
  "maxTotalUncompressedBytes",
  "maxEntryCompressedBytes",
  "maxEntryUncompressedBytes",
  "maxTotalReadUncompressedBytes",
];

export function validateLimits(limits: KohoZipLimits): void {
  if (limits === null || typeof limits !== "object") {
    throw new KohoZipError("invalid_limits");
  }

  for (const key of LIMIT_KEYS) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new KohoZipError("invalid_limits");
    }
  }
}
