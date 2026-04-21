import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const SRC_ROOT = path.join("node_modules", "pdfjs-dist");
const DEST_ROOT = path.join("vendor", "pdfjs-dist");

const DATA_DIRS = ["cmaps", "standard_fonts"];
const BUILD_FILES = ["pdf.mjs", "pdf.mjs.map", "pdf.worker.mjs", "pdf.worker.mjs.map"];

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

async function copyFiles(srcDir, destDir, names) {
  await mkdir(destDir, { recursive: true });
  for (const name of names) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    await copyFile(src, dest).catch((err) => {
      if (err.code === "ENOENT") return;
      throw err;
    });
  }
}

for (const dir of DATA_DIRS) {
  const count = await copyDir(path.join(SRC_ROOT, dir), path.join(DEST_ROOT, dir));
  console.log(`copied ${count} files -> ${path.join(DEST_ROOT, dir)}`);
}

const buildSrc = path.join(SRC_ROOT, "legacy", "build");
const buildDest = path.join(DEST_ROOT, "legacy", "build");
await copyFiles(buildSrc, buildDest, BUILD_FILES);
console.log(`copied build files -> ${buildDest}`);
