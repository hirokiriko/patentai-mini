import { Readable } from "node:stream";
import type { BlobClient } from "@azure/storage-blob";
import { describe, expect, it, vi } from "vitest";
import { buildZip } from "../koho-zip/__fixtures__/zip-builder";
import { openKohoZip } from "../koho-zip";
import { openInternalSource } from "../koho-zip/source";
import { buildManagedImportLimits } from "./managed-limits";
import { sha256 } from "./cloud-config";
import { verifiedUploadSource } from "./upload-source";

const etag = '"fictional1"';
const deadline = () => AbortSignal.timeout(20_000);
function fixture(bytes: Buffer, change: Record<string, unknown> = {}, transform = (b: Buffer) => b) {
  const getProperties = vi.fn(async () => ({ etag, contentLength: bytes.length, blobType: "BlockBlob" }));
  const download = vi.fn(async (offset: number, length: number) => ({ etag, contentLength: length,
    contentRange: `bytes ${offset}-${offset + length - 1}/${bytes.length}`,
    readableStreamBody: Readable.from([transform(bytes.subarray(offset, offset + length))]), ...change }));
  return { getProperties, download, blob: { getProperties, download } as unknown as Pick<BlobClient, "getProperties" | "download"> };
}
describe("private upload ZIP source", () => {
  it("checks full hash and parses stored/deflated entries through the existing bounded parser", async () => {
    const payload = "公開請求項テスト\n" + Array.from({ length: 4000 }, (_, i) => sha256(String(i))).join("\n");
    const zip = buildZip({ entries: [{ fileName: "FICT/a.xml", data: payload, compressionMethod: 8 },
      { fileName: "FICT/b.csv", data: "one,two\n", compressionMethod: 0 }] }).bytes;
    const f = fixture(zip), verified = await verifiedUploadSource(f.blob, { byteLength: zip.length, etag, sha256: sha256(zip) }, deadline());
    const reader = await openKohoZip({ source: verified.source, limits: buildManagedImportLimits(zip.length).zip });
    try {
      expect(verified.sha256).toBe(sha256(zip));
      expect(reader.summary.sourceType).toBe("range");
      expect(Buffer.from(await reader.readEntryBytes(0)).toString()).toBe(payload);
      expect(Buffer.from(await reader.readEntryBytes(1)).toString()).toBe("one,two\n");
      expect(f.download).toHaveBeenCalledTimes(1);
      expect(f.download.mock.calls[0]).toEqual([0, zip.length, expect.objectContaining({ conditions: { ifMatch: etag }, maxRetryRequests: 0 })]);
    } finally { await reader.close(); }
    await expect(verified.source.readRange(0, 1)).rejects.toThrow();
  });

  it.each([{ etag: '"changed"' }, { contentLength: 1 }, { contentRange: "bytes 0-1/9999" }])("rejects changed range identity %j", async change => {
    const f = fixture(Buffer.from("fictional ZIP bytes"), change);
    await expect(verifiedUploadSource(f.blob, { byteLength: 19, etag }, deadline())).rejects.toThrow("koho_upload_verification_failed");
  });
  it.each(["short", "overlong"])("rejects %s streamed bytes", async mode => {
    const bytes = Buffer.from("fictional"), f = fixture(bytes, {}, b => mode === "short" ? b.subarray(1) : Buffer.concat([b, b]));
    await expect(verifiedUploadSource(f.blob, { byteLength: bytes.length, etag }, deadline())).rejects.toThrow("koho_upload_verification_failed");
  });
  it("rejects a full source digest mismatch before ZIP parsing", async () => {
    const bytes = Buffer.from("fictional"), f = fixture(bytes);
    await expect(verifiedUploadSource(f.blob, { byteLength: bytes.length, etag, sha256: "a".repeat(64) }, deadline())).rejects.toThrow("koho_upload_verification_failed");
  });
  it("retains the approved digest when the caller mutates its input during IO", async () => {
    const bytes = Buffer.from("fictional"), f = fixture(bytes);
    const expected = { byteLength: bytes.length, etag, sha256: "a".repeat(64) };
    f.getProperties.mockImplementation(async () => { expected.sha256 = sha256(bytes);
      return { etag, contentLength: bytes.length, blobType: "BlockBlob" }; });
    await expect(verifiedUploadSource(f.blob, expected, deadline())).rejects.toThrow("koho_upload_verification_failed");
  });
  it("reads across cache-block boundaries and keeps requests and memory bounded", async () => {
    const bytes = Buffer.alloc(5 * 1024 * 1024, 7); bytes[4 * 1024 * 1024] = 9;
    const f = fixture(bytes), v = await verifiedUploadSource(f.blob, { byteLength: bytes.length, etag }, deadline());
    expect(await v.source.readRange(4 * 1024 * 1024 - 1, 3)).toEqual(Buffer.from([7, 9, 7]));
    expect(f.download).toHaveBeenCalledTimes(2);
    await v.source.close();
  });
  it("does no body reads after abort", async () => {
    const bytes = Buffer.from("fictional"), f = fixture(bytes), abort = new AbortController(); abort.abort();
    await expect(verifiedUploadSource(f.blob, { byteLength: bytes.length, etag }, abort.signal)).rejects.toThrow();
    expect(f.download).not.toHaveBeenCalled();
  });
  it("supports offsets above 4GiB without allocating or storing a full ZIP", async () => {
    const readRange = vi.fn(async (_offset: number, length: number) => Buffer.alloc(length, 11));
    const close = vi.fn(async () => {}), size = 8 * 1024 ** 3;
    const source = await openInternalSource({ type: "range", byteLength: size, readRange, close }, size);
    const tail = Buffer.alloc(17);
    await source.read(tail, 0, tail.length, size - tail.length);
    expect(readRange).toHaveBeenCalledWith(size - 17, 17); expect(tail).toEqual(Buffer.alloc(17, 11));
    await source.close(); await source.close(); expect(close).toHaveBeenCalledTimes(1);
  });
  it("rejects malformed and truncated range sources without accepting a partial entry", async () => {
    const source = await openInternalSource({ type: "range", byteLength: 100,
      readRange: async () => Buffer.alloc(1), close: async () => {} }, 100);
    await expect(source.read(Buffer.alloc(10), 0, 10, 0)).rejects.toMatchObject({ code: "source_invalid" });
    await expect(source.read(Buffer.alloc(10), 0, 10, 99)).rejects.toMatchObject({ code: "source_invalid" });
    await source.close();
  });
});
