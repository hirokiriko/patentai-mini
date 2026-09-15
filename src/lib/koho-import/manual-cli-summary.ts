import type { KohoPackageParseResult } from "../koho-package";
import type { KohoImportPlan } from "./types";
import { requireManual } from "./manual-cli-config";

export function summarizeManualPackage(result: KohoPackageParseResult, plan: KohoImportPlan) {
  const days = new Map<string, number>();
  for (const d of plan.documents) {
    const raw = d.publicationDate.replaceAll("-", "");
    requireManual(/^\d{8}$/.test(raw));
    const date = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    requireManual(new Date(date).toISOString().slice(0, 10) === date);
    days.set(date, (days.get(date) ?? 0) + 1);
  }
  const counts = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }));
  const issueCounts = (items: { status: string }[]) => ({
    reviewRequired: items.filter(x => x.status === "review_required").length,
    unsupported: items.filter(x => x.status === "unsupported_type").length,
    failed: items.filter(x => x.status === "failed").length,
  });
  return {
    packageStatus: plan.packageStatus,
    documentCount: plan.documentCount,
    reviewDocumentCount: plan.documents.filter(d => d.parseStatus === "review_required").length,
    amendmentCount: plan.amendmentCount,
    attachmentCount: Object.values(result.counts.bySection).reduce((n, s) => n + s.attachmentCount, 0),
    nestedSt26Count: plan.nestedSt26Count,
    review: { packageIssues: issueCounts(result.issues),
      xmlIssues: issueCounts(result.primaryXmlResults.flatMap(x => x.result.issues)),
      unprocessedEntries: result.manifest.filter(x => x.status === "not_processed").length },
    publicationDates: { scope: "input_publications_only" as const,
      min: counts[0]?.date ?? null, max: counts.at(-1)?.date ?? null, counts },
  };
}
export type ManualSummary = ReturnType<typeof summarizeManualPackage>;
export type ManualOutcome = "preview_not_saved" | "inserted" | "reused" | "review_not_saved" |
  "failed_before_save" | "save_outcome_unknown" | "not_processed";
export interface ManualFileResult {
  ordinal: number;
  packageType: "JPA" | "JPB";
  outcome: ManualOutcome;
  summary?: ManualSummary;
  savedDocumentCount: number;
  includesReviewRequired: boolean;
}
