import type { PeriodSnapshot } from "./period-report";

// Entirely fictional; used by tests and the disposable loopback browser harness.
export const fixturePeriod = { from: "2096-03-01", to: "2096-03-31" };
export const SECRET_SENTINEL = "FICTIONAL_PERIOD_SECRET_SENTINEL";
export const RAW_SENTINEL = "FICTIONAL_RAW_CLAIMS_SENTINEL";
export function periodFixture(runCount = 2, findingCount = 3): PeriodSnapshot {
  const runs: PeriodSnapshot["runs"] = Array.from({ length: runCount }, (_, index) => ({
    runId: index + 1, watchId: 11, status: "completed", startedAt: "2096-03-01T00:00:00.000001Z", completedAt: "2096-04-01T00:01:00Z",
    newFindingCount: 0, fallbackFindingCount: 0,
  }));
  const findings: PeriodSnapshot["findings"] = Array.from({ length: findingCount }, (_, index) => {
    const run = runs[index % runs.length]; run.newFindingCount++;
    const fallback = index % 2 === 1;
    if (fallback) run.fallbackFindingCount++;
    return {
      findingId: index + 1, watchId: 11, firstRunId: run.runId, firstSeenAt: "2096-04-01T00:01:00Z",
      publicationNumber: "JP2096-000001A", publicationDate: "20960229", inventionTitle: "完全架空の軌道プリズム",
      lexicalScore: 0.5, elementScore: 0.4, semanticScore: 0.3, structuralScore: 0.2, riskLabel: "Unknown",
      analysisMode: fallback ? "fallback" : "ai", reviewStatus: fallback ? "reviewed" : "unreviewed",
      analysisJson: JSON.stringify({ matchedElements: ["完全架空の支持部材"], unmatchedElements: ["完全架空の回転機構"], explanation: `人による原文確認が必要な架空候補です。\napi_key=${SECRET_SENTINEL}` }),
    };
  });
  return { caseId: 7, watchId: 11, createdAt: "2096-04-02T00:01:00Z", runs, findings };
}
