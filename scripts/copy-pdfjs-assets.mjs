import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const SRC_ROOT = path.join("node_modules", "pdfjs-dist");
const DEST_ROOT = path.join("vendor", "pdfjs-dist");
const DIRS = ["cmaps", "standard_fonts"];

async function copyDir(srcDir, destDir) {
  await rm(destDir, { recursive: true, force: true });
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    await copyFile(path.join(srcDir, entry.name), path.join(destDir, entry.name));
  }
  return entries.length;
}

for (const dir of DIRS) {
  const count = await copyDir(path.join(SRC_ROOT, dir), path.join(DEST_ROOT, dir));
  console.log(`copied ${count} files -> ${path.join(DEST_ROOT, dir)}`);
}
