import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaseWatchRun, CaseWatchFinding } from "../../../../../../lib/patent-watch/types";
import Page from "./page";

const seam = vi.hoisted(() => ({ getRun: vi.fn(), listFindings: vi.fn(), findById: vi.fn(), write: vi.fn() }));
vi.mock("@/repositories", () => ({ caseRepo: seam, patentWatchRepo: seam }));
vi.mock("@/lib/patent-watch/domain", () => import("../../../../../../lib/patent-watch/domain"));
vi.mock("@/lib/patent-watch/api", () => import("../../../../../../lib/patent-watch/api"));
vi.mock("@/lib/patent-watch/period", () => import("../../../../../../lib/patent-watch/period"));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
const run: CaseWatchRun = {
  runId: 21, watchId: 11, status: "completed", monitoringFromDate: "20960301",
  startedAt: "2096-03-01T14:59:00Z", completedAt: "2096-03-01T15:00:00Z",
  baseRunUpdatedAt: null, baseImportId: null, upperRunUpdatedAt: null, upperImportId: null,
  scannedImportRunCount: 1, scannedDocumentCount: 1, prefilteredCount: 1, analyzedCount: 1,
  newFindingCount: 1, fallbackFindingCount: 0, analysisMode: "ai", errorCode: null,
};
const finding: CaseWatchFinding = {
  findingId: 31, watchId: 11, firstRunId: 21, firstSeenAt: run.completedAt!,
  sourceKey: "FICTIONAL_PRIVATE_SENTINEL", corpusDocumentId: 99, packageType: "JPA", kind: "A1",
  publicationNumber: "JP2096-000001A", publicationDate: "20960301", inventionTitle: "完全架空の検証例", abstractPreview: null,
  lexicalScore: 0.5, elementScore: 0.5, semanticScore: 0.5, structuralScore: 0.5,
  riskLabel: "Unknown", analysisMode: "ai", reviewStatus: "reviewed",
  analysisJson: JSON.stringify({ matchedElements: ["架空装置"], unmatchedElements: [], explanation: "AI応答は固定。人による確認が必要です。" }),
};
const render = async (caseId = "7", runId = "21") => renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId, runId }) }));
beforeEach(() => {
  vi.clearAllMocks(); seam.findById.mockResolvedValue({ caseId: 7 });
  seam.getRun.mockResolvedValue({ ...run }); seam.listFindings.mockResolvedValue([{ ...finding }]);
});
describe("single run report states", () => {
  it.each(([[], ["ai"], ["fallback"], ["ai", "fallback"]] as Array<Array<"ai" | "fallback">>).map(modes => ({ modes })))("limits the scope notice to actual AI findings: %j", async ({ modes }) => {
    seam.getRun.mockResolvedValue({ ...run, newFindingCount: modes.length,
      fallbackFindingCount: modes.filter(mode => mode === "fallback").length });
    seam.listFindings.mockResolvedValue(modes.map((analysisMode, index) => ({ ...finding, findingId: 31 + index, analysisMode })));
    const html = await render();
    expect(html.includes('aria-label="AI比較の範囲"')).toBe(modes.includes("ai"));
    if (modes.includes("ai")) {
      expect(html).toContain("明細書全文や請求項の残りは比較範囲に含みません");
      expect(html).toContain("fallback候補はAI詳細比較の結果ではありません");
    }
  });
  it.each(["failed", "running"] as const)("prints %s as incomplete without zero results", async status => {
    seam.getRun.mockResolvedValue({ ...run, status, completedAt: status === "running" ? null : run.completedAt, newFindingCount: 0 });
    seam.listFindings.mockResolvedValue([]);
    const html = await render();
    expect(html).toContain(status === "failed" ? "失敗" : "実行中");
    expect(html).toContain("結果は未確定");
    expect(html).not.toContain("監視実行サマリー"); expect(html).not.toContain("確認候補はありません");
    expect(seam.listFindings).not.toHaveBeenCalled(); expect(seam.write).not.toHaveBeenCalled();
  });
  it("shows completed rows and Japan midnight independent of server timezone", async () => {
    const html = await render();
    expect(html).toContain("完了"); expect(html).toContain("2096/03/02 0:00 JST"); expect(html).toContain("日本時間");
    expect(html).toContain("完全架空の検証例"); expect(html).toContain("確認済み");
    expect(html).not.toContain("FICTIONAL_PRIVATE_SENTINEL");
  });
  it("reserves zero results for consistent completed runs", async () => {
    seam.getRun.mockResolvedValue({ ...run, newFindingCount: 0 }); seam.listFindings.mockResolvedValue([]);
    expect(await render()).toContain("このrunで追加された確認候補はありません");
  });
  it.each(["case read", "run read", "finding read", "missing row", "invalid row", "cap"])("fails closed for %s", async scenario => {
    if (scenario === "case read") seam.findById.mockRejectedValue(new Error("FICTIONAL_PRIVATE_SENTINEL"));
    if (scenario === "run read") seam.getRun.mockRejectedValue(new Error("FICTIONAL_PRIVATE_SENTINEL"));
    if (scenario === "finding read") seam.listFindings.mockRejectedValue(new Error("FICTIONAL_PRIVATE_SENTINEL"));
    if (scenario === "missing row") seam.listFindings.mockResolvedValue([]);
    if (scenario === "invalid row") seam.listFindings.mockResolvedValue([{ ...finding, analysisJson: "FICTIONAL_PRIVATE_SENTINEL" }]);
    if (scenario === "cap") seam.getRun.mockResolvedValue({ ...run, newFindingCount: 101 });
    const html = await render(); expect(html).toContain("データ取得不能");
    expect(html).not.toContain("監視実行サマリー"); expect(html).not.toContain("確認候補はありません"); expect(html).not.toContain("FICTIONAL_PRIVATE_SENTINEL");
  });
  it("404s for missing cases, runs, other-case runs and invalid IDs", async () => {
    seam.findById.mockResolvedValueOnce(null); await expect(render()).rejects.toThrow("NOT_FOUND");
    seam.getRun.mockResolvedValue(null); await expect(render()).rejects.toThrow("NOT_FOUND");
    await expect(render("8")).rejects.toThrow("NOT_FOUND");
    await expect(render("0")).rejects.toThrow("NOT_FOUND");
  });
});
