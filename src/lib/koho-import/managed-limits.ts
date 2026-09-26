import { buildKohoManualImportLimits } from "./manual-api";
import { requireManual } from "./manual-cli-config";

/** Issue #129 permits larger compressed ZIPs, not larger parser expansion or entries. */
export function buildManagedImportLimits(sourceBytes: number) {
  requireManual(Number.isSafeInteger(sourceBytes) && sourceBytes > 0 && sourceBytes <= 8 * 1024**3);
  const limits = buildKohoManualImportLimits(Math.min(sourceBytes, 2 * 1024**3));
  return { ...limits, zip: { ...limits.zip, maxSourceBytes: sourceBytes, maxTotalCompressedBytes: sourceBytes } };
}
