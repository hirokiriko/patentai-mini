import type { KohoPackageParseResult } from "../koho-package";
import type { KohoImportPlan } from "./types";
import { projectManagedClaimSource } from "./managed-claim-source";
import { projectManagedPackageReceipt } from "./managed-package-receipt";
import { managedDigest } from "../patent-watch/managed-claims";
import { ManagedWatchError } from "../patent-watch/managed-types";
export function projectManagedPackage(parsed: KohoPackageParseResult, plan: KohoImportPlan) {
  const results = new Map(parsed.primaryXmlResults.map(r => [r.normalizedPath, r.result]));
  const sources = plan.documents.map(document => {
    const result = results.get(document.normalizedEntryPath);
    if (!result || !("document" in result) || !result.document) throw new ManagedWatchError("incomplete");
    return projectManagedClaimSource(result.document, document, plan.sourceSha256);
  });
  const receipt = projectManagedPackageReceipt(parsed, plan);
  return { sources, receipt, managedSourcesSha256: managedDigest(sources), managedReceiptSha256: managedDigest(receipt) };
}
