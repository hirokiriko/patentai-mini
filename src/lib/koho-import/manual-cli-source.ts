import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { requireLocalPath, requireManual } from "./manual-cli-config";

// Apply the same local-directory boundary to inputs and the snapshot destination.
export async function inspectManualDirectory(path: string) {
  requireLocalPath(path);
  let parent = resolve(path);
  const ancestors: string[] = [];
  while (true) {
    ancestors.push(parent);
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  // Inspect a link itself before resolving any child through it (including UNC targets).
  for (const ancestor of ancestors.reverse()) {
    const entry = await lstat(ancestor);
    requireManual(entry.isDirectory() && !entry.isSymbolicLink());
  }
}
export async function inspectManualSource(path: string, limit: number) {
  requireLocalPath(path);
  await inspectManualDirectory(dirname(resolve(path)));
  const stat = await lstat(path);
  requireManual(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit);
  return stat;
}
type SourceStat = Awaited<ReturnType<typeof lstat>>;
function unchanged(a: SourceStat, b: SourceStat) {
  requireManual(b.isFile() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino &&
    a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs);
}
async function hashHandle(handle: FileHandle, size: number) {
  const hash = createHash("sha256"); const buffer = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead; requireManual(offset <= size); hash.update(buffer.subarray(0, bytesRead));
  }
  requireManual(offset === size); return hash.digest("hex");
}
export async function copyManualSource(path: string, snapshot: string, size: number, onCreated?: (stat: SourceStat) => Promise<void>) {
  const before = await inspectManualSource(path, size); requireManual(before.size === size);
  const source = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    unchanged(before, await source.stat());
    const dest = await open(snapshot, "wx", 0o600);
    const hash = createHash("sha256"); let copied = 0;
    try {
      if (onCreated) await onCreated(await dest.stat());
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, copied);
        if (!bytesRead) break;
        copied += bytesRead; requireManual(copied <= size);
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const x = await dest.write(buffer, written, bytesRead - written, null);
          requireManual(x.bytesWritten > 0); written += x.bytesWritten;
        }
      }
      requireManual(copied === size); await dest.sync();
    } finally { await dest.close(); }
    unchanged(before, await source.stat()); unchanged(before, await lstat(path));
    const digest = hash.digest("hex");
    requireManual(await hashHandle(source, size) === digest);
    unchanged(before, await source.stat()); unchanged(before, await lstat(path));
    return digest;
  } finally { await source.close(); }
}
/** Resume only an owned partial copy. Existing bytes must match the untouched
 * source prefix; writes append, never truncate or replace a file. */
export async function resumeManualSourceCopy(path: string, snapshot: string, size: number, digest: string, identity: { dev: number; ino: number }) {
  const before = await inspectManualSource(path,size); requireManual(before.size === size);
  await inspectManualDirectory(dirname(resolve(snapshot)));
  const partial = await lstat(snapshot);
  requireManual(partial.isFile() && !partial.isSymbolicLink() && partial.nlink === 1 && partial.dev === identity.dev && partial.ino === identity.ino && partial.size <= size);
  const source = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    unchanged(before,await source.stat());
    requireManual(await hashHandle(source,size) === digest);
    unchanged(before,await source.stat());unchanged(before,await lstat(path));
    const dest = await open(snapshot,constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      unchanged(partial,await dest.stat());
      const buffer = Buffer.alloc(64*1024), existing = Buffer.alloc(64*1024); let offset = 0;
      while(offset < size) {
        const length = Math.min(buffer.length,size-offset,offset < partial.size ? partial.size-offset : buffer.length);
        const read = await source.read(buffer,0,length,offset); requireManual(read.bytesRead === length);
        if(offset < partial.size) {
          const old = await dest.read(existing,0,length,offset); requireManual(old.bytesRead === length && existing.subarray(0,length).equals(buffer.subarray(0,length)));
        } else {
          let written = 0;
          while(written < length) { const w = await dest.write(buffer,written,length-written,offset+written); requireManual(w.bytesWritten>0); written += w.bytesWritten; }
        }
        offset += length;
      }
      await dest.sync();
      requireManual(await hashHandle(source,size) === digest && await hashHandle(dest,size) === digest);
      const final = await dest.stat(), named = await lstat(snapshot);
      requireManual(final.nlink === 1 && final.dev === partial.dev && final.ino === partial.ino); unchanged(final,named);
      unchanged(before,await source.stat()); unchanged(before,await lstat(path));
    } finally { await dest.close(); }
  } finally { await source.close(); }
}
export async function verifyManualSnapshot(path: string, size: number, digest: string) {
  const before = await inspectManualSource(path, size); requireManual(before.size === size);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    unchanged(before, await handle.stat());
    requireManual(await hashHandle(handle, size) === digest);
    unchanged(before, await handle.stat()); unchanged(before, await lstat(path));
  } finally { await handle.close(); }
}
export async function hashManualSource(path: string, limit: number) {
  const before=await inspectManualSource(path,limit),handle=await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try{unchanged(before,await handle.stat());const sha256=await hashHandle(handle,before.size);
    unchanged(before,await handle.stat());unchanged(before,await lstat(path));return{byteLength:before.size,sha256,stat:before};}
  finally{await handle.close();}
}
