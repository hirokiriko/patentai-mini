import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { manualFixture } from "./koho-manual-import-fixtures";
import { previewManagedKoho } from "./managed-koho-preview";
import { fictionalP6Package } from "../src/lib/koho-import/p6-package.test-support";

it("reports measured aggregate capacity and receipt counts without source text or paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "managed-preview-test-"));
  try {
    const bytes = manualFixture("JPA", 2, { publicationDate: "2026-08-12", issue: "2026-148", control: "01115" });
    const sourcePath = join(directory, "FICTIONAL_PRIVATE_PATH.zip");
    await writeFile(sourcePath, bytes);
    const result = await previewManagedKoho({ schema: 1, sourcePath, byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(result.publicationCounts).toEqual({ A1: 2, P1: 0, A5: 0, P5: 0 });
    expect(result.correctionCoverage).toEqual({ missingOriginalDate: 0, missingOriginalNumber: 0 });
    expect(result.zip!.declaredUncompressedBytes).toBeGreaterThan(0);
    expect(result.zip!.entries).toBeGreaterThan(2);
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.peakRssKiB).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/FICTIONAL_PRIVATE_PATH|claimsJson|normalizedPath|sourcePath/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reports P6 separately without exposing correction text", async () => {
  const directory = await mkdtemp(join(tmpdir(), "managed-preview-p6-test-"));
  try {
    const bytes = fictionalP6Package({ payload: "image", previousPublicationDate: null });
    const sourcePath = join(directory, "FICTIONAL_PRIVATE_P6.zip");
    await writeFile(sourcePath, bytes);
    const result = await previewManagedKoho({ schema: 1, sourcePath, byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(result.documentCount).toBe(1);
    expect(result.amendments).toBe(0);
    expect(result.publicationCounts).toEqual({ A1: 1, P1: 0, A5: 0, P5: 0, P6: 1 });
    expect(result.unresolvedCorrections).toBe(1);
    expect(result.correctionCoverage).toEqual({ missingOriginalDate: 1, missingOriginalNumber: 0 });
    expect(JSON.stringify(result)).not.toMatch(/FICTIONAL_PRIVATE_P6|correctionContent|correctionGist|sourcePath|2099000007/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
