import { mkdtemp, writeFile, appendFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, expect, it, vi } from "vitest";
import { copyManualSource, inspectManualDirectory } from "../src/lib/koho-import/manual-cli-source";

const fault = vi.hoisted(() => ({ mode: "", source: "", hit: false }));
vi.mock("node:fs/promises", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, lstat: async (...args: Parameters<typeof fs.lstat>) => {
    if (fault.mode === "ancestor") {
      if (args[0] === fault.source) return { isDirectory: () => true, isSymbolicLink: () => true };
      if (String(args[0]).startsWith(fault.source)) { fault.hit = true; throw Error("FICTIONAL_EXTERNAL_FS_GUARD"); }
    }
    return fs.lstat(...args);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args);
    if (args[0] === fault.source) {
      const read = handle.read.bind(handle);
      handle.read = (async (...values: Parameters<typeof handle.read>) => {
        if (!fault.hit && fault.mode === "short") { fault.hit = true; return { bytesRead: 0, buffer: values[0] }; }
        const value = await Reflect.apply(read, handle, values);
        if (!fault.hit && fault.mode === "growth") { fault.hit = true; await appendFile(fault.source, Buffer.alloc(100)); }
        return value;
      }) as typeof handle.read;
    }
    return handle;
  } };
});
it("rejects an ancestor link before making any filesystem call to its child", async () => {
  fault.mode = "ancestor"; fault.source = join(tmpdir(), "koho-manual-fictional-link");
  await expect(inspectManualDirectory(join(fault.source, "child"))).rejects.toThrow("manual_import_stopped");
  expect(fault.hit).toBe(false);
});
beforeEach(() => { fault.hit = false; });
it.each(["short", "growth"])("rejects %s during copy without changing other inputs or accepting a partial snapshot", async mode => {
  const directory = await mkdtemp(join(tmpdir(), "koho-manual-source-fault-"));
  try {
    fault.mode = mode; fault.source = join(directory, "source.zip");
    const other = join(directory, "other-original.zip"), otherBytes = Buffer.from("FICTIONAL-OTHER-ORIGINAL");
    await writeFile(fault.source, Buffer.alloc(100_000)); await writeFile(other, otherBytes);
    await expect(copyManualSource(fault.source, join(directory, "snapshot.zip"), 100_000)).rejects.toThrow("manual_import_stopped");
    expect(fault.hit).toBe(true); expect(await readFile(other)).toEqual(otherBytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
