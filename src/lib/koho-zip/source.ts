import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";

import { KohoZipError } from "./errors";
import type { KohoZipSource } from "./types";

export interface InternalZipSource {
  readonly type: KohoZipSource["type"];
  readonly sourceName: string | null;
  readonly size: number;
  read(target: Uint8Array, offset: number, length: number, position: number): Promise<number>;
  createReadStream(start: number, end: number): Readable;
  close(): Promise<void>;
}

class FileZipSource implements InternalZipSource {
  readonly type = "file" as const;
  readonly sourceName = null;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly handle: FileHandle,
    readonly size: number,
  ) {}

  async read(
    target: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    try {
      const result = await this.handle.read(target, offset, length, position);
      return result.bytesRead;
    } catch {
      throw new KohoZipError("source_invalid");
    }
  }

  createReadStream(start: number, end: number): Readable {
    let position = start;
    let readInProgress = false;
    const handle = this.handle;

    return new Readable({
      read(requestedSize) {
        if (readInProgress) return;
        if (position >= end) {
          this.push(null);
          return;
        }

        const length = Math.min(Math.max(requestedSize, 1), end - position);
        const chunk = Buffer.allocUnsafe(length);
        readInProgress = true;
        void handle.read(chunk, 0, length, position).then(
          ({ bytesRead }) => {
            readInProgress = false;
            if (this.destroyed) return;
            if (bytesRead <= 0) {
              this.destroy(new KohoZipError("source_invalid"));
              return;
            }
            position += bytesRead;
            this.push(
              bytesRead === chunk.byteLength
                ? chunk
                : chunk.subarray(0, bytesRead),
            );
          },
          () => {
            readInProgress = false;
            this.destroy(new KohoZipError("source_invalid"));
          },
        );
      },
    });
  }

  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = this.handle.close().catch(() => {
        throw new KohoZipError("source_invalid");
      });
    }
    return this.closePromise;
  }
}

class BufferZipSource implements InternalZipSource {
  readonly type = "buffer" as const;
  readonly size: number;

  constructor(
    private readonly bytes: Uint8Array,
    readonly sourceName: string | null,
  ) {
    this.size = bytes.byteLength;
  }

  async read(
    target: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number> {
    const view = this.bytes.subarray(position, position + length);
    target.set(view, offset);
    return view.byteLength;
  }

  createReadStream(start: number, end: number): Readable {
    return Readable.from([this.bytes.subarray(start, end)]);
  }

  async close(): Promise<void> {}
}

export async function openInternalSource(
  source: KohoZipSource,
  maxSourceBytes: number,
): Promise<InternalZipSource> {
  if (source === null || typeof source !== "object") {
    throw new KohoZipError("source_invalid");
  }

  if (source.type === "buffer") {
    if (
      !(source.bytes instanceof Uint8Array) ||
      (source.sourceName !== undefined && typeof source.sourceName !== "string")
    ) {
      throw new KohoZipError("source_invalid");
    }
    validateSourceSize(source.bytes.byteLength, maxSourceBytes);
    return new BufferZipSource(source.bytes, source.sourceName ?? null);
  }

  if (source.type !== "file" || typeof source.path !== "string") {
    throw new KohoZipError("source_invalid");
  }

  let handle: FileHandle;
  try {
    handle = await open(source.path, "r");
  } catch {
    throw new KohoZipError("source_invalid");
  }

  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile() || stats.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new KohoZipError("source_invalid");
    }
    const size = Number(stats.size);
    validateSourceSize(size, maxSourceBytes);
    return new FileZipSource(handle, size);
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof KohoZipError) throw error;
    throw new KohoZipError("source_invalid");
  }
}

function validateSourceSize(size: number, maxSourceBytes: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new KohoZipError("source_invalid");
  }
  if (size > maxSourceBytes) {
    throw new KohoZipError("source_too_large");
  }
}
