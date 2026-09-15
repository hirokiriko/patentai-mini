import type { WatchFindingView, WatchRunView, WatchSummary } from "./watch-section";

// Completely fictional fixtures shared by component events and loopback visual QA.
export function runFixture(status: WatchRunView["status"] = "completed", changes: Partial<WatchRunView> = {}): WatchRunView {
  return {
    runId: 21, status, startedAt: "2096-03-01T00:00:00Z",
    completedAt: status === "running" ? null : "2096-03-01T00:01:00Z",
    scannedImportRunCount: 1, scannedDocumentCount: 2, prefilteredCount: 1,
    analyzedCount: 1, newFindingCount: status === "completed" ? 1 : 0,
    fallbackFindingCount: 0, analysisMode: status === "completed" ? "ai" : "none",
    errorCode: status === "failed" ? "watch_internal_error" : null, ...changes,
  };
}

export function findingFixture(): WatchFindingView {
  return {
    findingId: 31, firstRunId: 21, packageType: "JPA", kind: "A1",
    publicationNumber: "JP2096-000001A", publicationDate: "20960301",
    inventionTitle: "完全架空の軌道プリズム", abstractPreview: null,
    lexicalScore: 0.5, elementScore: 0.4, semanticScore: 0.3, structuralScore: 0.2,
    riskLabel: "Unknown", matchedElements: [], unmatchedElements: [],
    explanation: "完全架空の確認候補です。人による確認が必要です。", analysisMode: "ai",
    reviewStatus: "reviewed", firstSeenAt: "2096-03-01T00:01:00Z",
  };
}

export function summaryFixture(latestRun: WatchRunView | null = null): WatchSummary {
  return {
    setting: { watchId: 11, enabled: true, monitoringFromDate: "20960301",
      createdAt: "2096-03-01T00:00:00Z", updatedAt: "2096-03-01T00:00:00Z" },
    latestRun, unreviewedFindingCount: latestRun?.newFindingCount ?? 0,
    runs: latestRun ? [latestRun] : [], findings: [],
  };
}
