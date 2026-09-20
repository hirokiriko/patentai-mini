import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPeriodReport } from "../../../../../lib/patent-watch/period-report";
import { fixturePeriod, periodFixture, RAW_SENTINEL, SECRET_SENTINEL } from "../../../../../lib/patent-watch/period-fixtures.test-support";
import { PeriodReportView, PERIOD_REPORT_PRINT_CSS } from "./report-view";
import Page from "./page";

const seam = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@/repositories", () => ({ patentWatchRepo: { readPeriodSnapshot: seam.read, startRun: seam.write, updateFindingReviewStatus: seam.write } }));
vi.mock("@/lib/patent-watch/period", () => import("../../../../../lib/patent-watch/period"));
vi.mock("@/lib/patent-watch/period-report", () => import("../../../../../lib/patent-watch/period-report"));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); } }));
const render = (snapshot = periodFixture()) => renderToStaticMarkup(<PeriodReportView caseId={7} period={fixturePeriod} result={{ kind: "ready", report: buildPeriodReport(7, fixturePeriod, snapshot) }} />);
beforeEach(() => { vi.clearAllMocks(); seam.read.mockResolvedValue(periodFixture()); });
describe("period server page and print view", () => {
  it.each(([[], ["ai"], ["fallback"], ["ai", "fallback"]] as Array<Array<"ai" | "fallback">>).map(modes => ({ modes })))("prints a scope notice only when there are AI findings: %j", ({ modes }) => {
    const snapshot = periodFixture(1, modes.length);
    snapshot.findings.forEach((finding, index) => { finding.analysisMode = modes[index]; });
    snapshot.runs[0].fallbackFindingCount = modes.filter(mode => mode === "fallback").length;
    const html = render(snapshot);
    expect(html.includes('aria-label="AI比較の範囲"')).toBe(modes.includes("ai"));
    if (modes.includes("ai")) {
      expect(html).toContain("先頭最大2,000文字");
      expect(html).toContain("公報全体に記載がないという意味ではありません");
      expect(html).toContain("fallback候補はAI詳細比較の結果ではありません");
    }
  });
  it.each([{}, { from: "bad", to: "bad" }, { from: ["2096-03-01", "2096-03-01"], to: "2096-03-31" }, { from: "2096-03-01", to: "2096-03-31", secret: SECRET_SENTINEL }])("performs no aggregate read for empty/invalid query", async query => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7" }), searchParams: Promise.resolve(query) }));
    expect(seam.read).not.toHaveBeenCalled(); expect(seam.write).not.toHaveBeenCalled();
    expect(html).not.toContain(SECRET_SENTINEL); expect(html).not.toContain("新規候補数: 0");
  });
  it("reads exactly once after explicit navigation and preserves the selected period", async () => {
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7" }), searchParams: Promise.resolve(fixturePeriod) }));
    expect(seam.read).toHaveBeenCalledExactlyOnceWith(7, fixturePeriod); expect(seam.write).not.toHaveBeenCalled();
    expect(html).toContain("2096-03-01"); expect(html).toContain("JST"); expect(html).toContain("単一runレポート");
    expect(html).not.toContain(SECRET_SENTINEL); expect(html).not.toContain(RAW_SENTINEL); expect(html).not.toContain("prefetch");
  });
  it("distinguishes no records, complete zero, all failed, running, mixed and unavailable", () => {
    expect(render(periodFixture(0, 0))).toContain("実行記録なし");
    expect(render(periodFixture(1, 0))).toContain("完了した実行の新規候補は0件");
    for (const status of ["failed", "running"] as const) {
      const snapshot = periodFixture(1, 0); snapshot.runs[0].status = status;
      if (status === "running") snapshot.runs[0].completedAt = null;
      const html = render(snapshot);
      expect(html).toContain("不完全なレポート"); expect(html).toContain("新規候補の有無は未確定"); expect(html).not.toContain("新規候補は0件");
    }
    const mixed = periodFixture(2, 1); mixed.runs[1].status = "failed";
    const html = render(mixed); expect(html).toContain("不完全なレポート"); expect(html).toContain("完全架空の軌道プリズム");
    for (const kind of ["unavailable", "too_many"] as const) {
      const errorHtml = renderToStaticMarkup(<PeriodReportView caseId={7} period={fixturePeriod} result={{ kind }} />);
      expect(errorHtml).not.toContain("data-finding-id"); expect(errorHtml).not.toContain("期間の集計");
      expect(errorHtml).toContain(kind === "unavailable" ? "データ取得不能" : "対象が多いため期間を短く");
    }
  });
  it("renders beyond the old list limits and retains legal/scope warnings outside print-hidden controls", () => {
    const html = render(periodFixture(21, 101));
    expect(html.match(/data-finding-id=/g)).toHaveLength(101);
    expect(html).toContain("実行件数: 21件"); expect(html).toContain("新規候補数: 101件");
    for (const text of ["監視実行開始日（日本時間）", "レポート作成時点", "法的判断ではありません", "全件のAI精読", "J-PlatPat", "自己案件の除外"]) expect(html).toContain(text);
    expect(PERIOD_REPORT_PRINT_CSS).toContain("article { break-inside: auto; overflow: visible;");
    expect(PERIOD_REPORT_PRINT_CSS).not.toMatch(/aside.*display|section.*display|height:|overflow: hidden/);
  });
  it("returns a fixed failed read and 404 for nonexistent/invalid cases", async () => {
    seam.read.mockRejectedValueOnce(new Error(SECRET_SENTINEL));
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: "7" }), searchParams: Promise.resolve(fixturePeriod) }));
    expect(html).toContain("データ取得不能"); expect(html).not.toContain(SECRET_SENTINEL);
    seam.read.mockResolvedValueOnce(null);
    await expect(Page({ params: Promise.resolve({ caseId: "7" }), searchParams: Promise.resolve(fixturePeriod) })).rejects.toThrow("NOT_FOUND");
    await expect(Page({ params: Promise.resolve({ caseId: "00" }), searchParams: Promise.resolve(fixturePeriod) })).rejects.toThrow("NOT_FOUND");
  });
});
