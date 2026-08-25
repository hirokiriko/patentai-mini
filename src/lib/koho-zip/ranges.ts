import { KohoZipError } from "./errors";

interface ByteRange {
  start: number;
  end: number;
}

/** Metadata read ranges are merged so overlapping random reads count once. */
export class UniqueByteRangeCounter {
  private ranges: ByteRange[] = [];
  private totalBytes = 0;

  constructor(private readonly limit: number) {}

  get total(): number {
    return this.totalBytes;
  }

  add(start: number, end: number): void {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      throw new KohoZipError("invalid_zip");
    }

    let mergedStart = start;
    let mergedEnd = end;
    let removedBytes = 0;
    const nextRanges: ByteRange[] = [];
    let inserted = false;

    for (const range of this.ranges) {
      if (range.end < mergedStart) {
        nextRanges.push(range);
        continue;
      }
      if (mergedEnd < range.start) {
        if (!inserted) {
          nextRanges.push({ start: mergedStart, end: mergedEnd });
          inserted = true;
        }
        nextRanges.push(range);
        continue;
      }

      mergedStart = Math.min(mergedStart, range.start);
      mergedEnd = Math.max(mergedEnd, range.end);
      removedBytes += range.end - range.start;
    }

    if (!inserted) {
      nextRanges.push({ start: mergedStart, end: mergedEnd });
    }

    const mergedBytes = mergedEnd - mergedStart;
    const nextTotal = this.totalBytes - removedBytes + mergedBytes;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.limit) {
      throw new KohoZipError("central_directory_too_large");
    }

    this.ranges = nextRanges;
    this.totalBytes = nextTotal;
  }
}
