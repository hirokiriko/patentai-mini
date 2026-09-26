import { createHash } from "node:crypto";
import type { BlobClient } from "@azure/storage-blob";
import type { KohoZipRangeSource } from "../koho-zip/types";
import { requireManual } from "./manual-cli-config";

const BLOCK = 4 * 1024 * 1024;
const MAX_BYTES = 8 * 1024 ** 3;

/** A fixed private Blob selected by the server, never a caller-supplied URL.
 * Hash the exact committed ETag once, then expose bounded random access to the
 * existing ZIP parser. Four cache blocks avoid one network GET per XML field. */
export async function verifiedUploadSource(blob: Pick<BlobClient, "getProperties" | "download">,
  expected: { byteLength: number; etag: string; sha256?: string }, signal: AbortSignal) {
  const { byteLength: size, etag, sha256: expectedSha256 } = expected;
  requireManual(Number.isSafeInteger(size) && size > 0 && size <= MAX_BYTES &&
    typeof etag === "string" && etag.length > 0 && etag.length <= 200 &&
    (expectedSha256 === undefined || /^[a-f0-9]{64}$/.test(expectedSha256)));
  // The caller supplies the whole Job deadline; every transport also has its own bound.
  const cache = new Map<number, Buffer>();
  let closed = false, bytesRead = 0, requests = 0;
  const maximumRead = size * 4 + BLOCK * 8;
  const maximumRequests = Math.ceil(size / BLOCK) * 4 + 8;
  const check = () => requireManual(!closed && !signal.aborted);
  const properties = await blob.getProperties({ conditions: { ifMatch: etag },
    abortSignal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  requireManual(properties.etag === etag && properties.contentLength === size && properties.blobType === "BlockBlob" && !properties.contentEncoding);

  async function block(offset: number): Promise<Buffer> {
    check();
    const saved = cache.get(offset);
    if (saved) { cache.delete(offset); cache.set(offset, saved); return saved; }
    const length = Math.min(BLOCK, size - offset);
    requireManual(length > 0 && requests < maximumRequests && bytesRead + length <= maximumRead);
    requests++; bytesRead += length;
    const response = await blob.download(offset, length, { conditions: { ifMatch: etag }, maxRetryRequests: 0,
      abortSignal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) });
    const stream = response.readableStreamBody;
    try {
      requireManual(response.etag === etag && response.contentLength === length &&
        response.contentRange === `bytes ${offset}-${offset + length - 1}/${size}` && stream);
      const result = Buffer.allocUnsafe(length); let copied = 0;
      for await (const chunk of stream!) {
        check(); requireManual(chunk instanceof Uint8Array && chunk.byteLength <= length - copied);
        result.set(chunk, copied); copied += chunk.byteLength;
      }
      check(); requireManual(copied === length);
      if (cache.size === 4) cache.delete(cache.keys().next().value!);
      cache.set(offset, result); return result;
    } finally { stream?.destroy(); }
  }

  try {
    const hash = createHash("sha256");
    for (let offset = 0; offset < size; offset += BLOCK) hash.update(await block(offset));
    const digest = hash.digest("hex");
    requireManual(expectedSha256 === undefined || expectedSha256 === digest);
    const source: KohoZipRangeSource = Object.freeze({ type: "range", byteLength: size,
      async readRange(offset: number, length: number) {
        check(); requireManual(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 &&
          length > 0 && length <= 64 * 1024 && offset + length <= size);
        const output = Buffer.allocUnsafe(length); let copied = 0;
        while (copied < length) {
          const position = offset + copied, start = Math.floor(position / BLOCK) * BLOCK;
          const bytes = await block(start), at = position - start;
          const count = Math.min(length - copied, bytes.length - at);
          requireManual(count > 0); output.set(bytes.subarray(at, at + count), copied); copied += count;
        }
        return output;
      },
      async close() { closed = true; cache.clear(); },
    });
    return { source, sha256: digest, byteLength: size, etag };
  } catch { closed = true; cache.clear(); throw Error("koho_upload_verification_failed"); }
}
