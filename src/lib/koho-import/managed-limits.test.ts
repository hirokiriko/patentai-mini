import { expect, it } from "vitest";
import { buildKohoManualImportLimits } from "./manual-api";
import { buildManagedImportLimits } from "./managed-limits";

it("retains every parser limit when the approved compressed source grows to 8 GiB", () => {
  const old = buildKohoManualImportLimits(2 * 1024**3);
  const managed = buildManagedImportLimits(8 * 1024**3);
  expect(managed).toEqual({ ...old, zip: { ...old.zip, maxSourceBytes: 8 * 1024**3, maxTotalCompressedBytes: 8 * 1024**3 } });
  expect(managed.zip.maxTotalUncompressedBytes).toBe(16 * 1024**3);
  expect(managed.zip.maxTotalReadUncompressedBytes).toBe(8 * 1024**3);
  expect(managed.zip.maxEntryUncompressedBytes).toBe(2 * 1024**3);
  expect(buildManagedImportLimits(1024)).toEqual(buildKohoManualImportLimits(1024));
});

it.each([0, -1, 1.5, NaN, Infinity, 8 * 1024**3 + 1])("rejects invalid or over-cap compressed bytes %s", value => {
  expect(() => buildManagedImportLimits(value)).toThrow();
});
