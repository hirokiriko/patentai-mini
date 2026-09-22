import { afterEach, describe, expect, it, vi } from "vitest";
import { DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { mkdir, writeFile } from "node:fs/promises";
import { buildPeriodReport } from "./period-report";
import { fixturePeriod, periodFixture, RAW_SENTINEL, SECRET_SENTINEL } from "./period-fixtures.test-support";
import { generatePeriodReportPdf, PERIOD_PDF_LIMITS } from "./period-report-pdf";
Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });
const normalize = (text: string) => text.replace(/\s/g, "");
const limits = { ...PERIOD_PDF_LIMITS };
afterEach(() => { Object.assign(PERIOD_PDF_LIMITS, limits); vi.restoreAllMocks(); });
async function extract(bytes: Buffer) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: false }).promise;
  const pages: string[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      expect(await page.getAnnotations()).toEqual([]);
      const items = (await page.getTextContent()).items;
      pages.push(items.map(item => "str" in item ? item.str : "").join("\n"));
    }
    const metadata = await pdf.getMetadata();
    expect(JSON.stringify(metadata)).not.toMatch(/SECRET_SENTINEL|RAW_CLAIMS|https?:|\\Users\\/);
    return pages;
  } finally { await pdf.destroy(); }
}
async function artifact(name: string, bytes: Buffer) {
  if (process.env.PERIOD_PDF_QA !== "1") return;
  await mkdir(".koho-ops/pdf-qa", { recursive: true });
  await writeFile(`.koho-ops/pdf-qa/${name}.pdf`, bytes);
}
describe("actual searchable period PDFs", () => {
  it("preserves every display field, long Japanese/ASCII tails, ordering, and sanitization", async () => {
    const snapshot = periodFixture(3, 4);
    snapshot.runs[2].status = "failed";
    // Move the third finding into the first successful run, preserving counts.
    snapshot.findings[2].firstRunId = 1; snapshot.runs[0].newFindingCount++;
    snapshot.runs[2].newFindingCount = 0;
    const explanation = "日本語の比較説明と原文確認。".repeat(65) + "ABCDEFGHIJKLMN0123456789".repeat(20) + "説明末尾確認";
    snapshot.findings[0].analysisJson = JSON.stringify({ matchedElements: ["一致候補テスト"], unmatchedElements: ["差分候補テスト"], explanation });
    Object.assign(snapshot.findings[0], { rawXml: RAW_SENTINEL, url: `https://example.invalid/?secret=${SECRET_SENTINEL}` });
    const report = buildPeriodReport(7, fixturePeriod, snapshot);
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("network forbidden"));
    const before = structuredClone(report);
    const bytes = await generatePeriodReportPdf(report);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    const pages = await extract(bytes), text = normalize(pages.join("\n"));
    expect(pages.length).toBeGreaterThan(2);
    for (const expected of ["案件 #7", "2096-03-01 〜 2096-03-31", "実行件数: 3件", "完了 2件", "失敗 1件", "新規候補数: 4件", "未確認 2件", "確認済み 2件", "AI 2件", "fallback 2件", "不完全なレポート", "法的判断ではありません", "先頭最大2,000文字", "明細書全文や請求項の残り", "Lowでも原文を確認", "自己案件の除外", explanation]) expect(text).toContain(normalize(expected));
    for (const f of report.findings) for (const expected of [f.publicationNumber, f.inventionTitle, f.riskLabel, f.analysisMode, f.explanation, ...f.matchedElements, ...f.unmatchedElements, `候補 #${f.findingId}`, `初検出run #${f.firstRunId}`, "2096/02/29", "2096/04/01 9:01 JST", "語彙 50%", "要素 40%", "意味 30%", "構造 20%"]) expect(text).toContain(normalize(expected));
    expect(text.indexOf("候補#1")).toBeLessThan(text.indexOf("候補#4"));
    for (const [index, page] of pages.entries()) expect(normalize(page)).toContain(`${index + 1}/${pages.length}`);
    expect(text).not.toContain(SECRET_SENTINEL); expect(text).not.toContain(RAW_SENTINEL);
    expect(fetch).not.toHaveBeenCalled(); expect(report).toEqual(before);
    await artifact("mixed-long", bytes);
  }, 30_000);
  it.each(["zero", "none", "failed-running"])("keeps %s distinct without fabricating success", async kind => {
    const snapshot = periodFixture(kind === "none" ? 0 : 2, 0);
    if (kind === "failed-running") { snapshot.runs[0].status = "failed"; snapshot.runs[1].status = "running"; snapshot.runs[1].completedAt = null; }
    const bytes = await generatePeriodReportPdf(buildPeriodReport(7, fixturePeriod, snapshot));
    const text = normalize((await extract(bytes)).join(""));
    expect(text).toContain(normalize(kind === "none" ? "実行記録なし" : kind === "zero" ? "完了した実行の新規候補は0件" : "新規候補の有無は未確定"));
    await artifact(kind, bytes);
  });
  it("labels archived origin and separates snapshot, preservation and generation times", async () => {
    const bytes = await generatePeriodReportPdf(buildPeriodReport(7, fixturePeriod, periodFixture()), { kind: "archive", preservedAt: "2096-04-03T01:00:00Z" });
    const text = normalize((await extract(bytes)).join(""));
    for (const value of ["本番保存結果の保全版から生成", "本番ブラウザー印刷の再現ではない", "保存結果の時点", "保全日時", "PDF生成日時", "稼働中リンクはありません"]) expect(text).toContain(value);
  });
  it("detects an unsupported glyph instead of emitting a missing square", async () => {
    const snapshot = periodFixture(); snapshot.findings[0].inventionTitle = "未対応\u{10FFFF}";
    await expect(generatePeriodReportPdf(buildPeriodReport(7, fixturePeriod, snapshot))).rejects.toMatchObject({ reason: "glyph" });
  });
  it("retains all 101 candidates and 21 runs beyond the old list limits", async () => {
    const report = buildPeriodReport(7, fixturePeriod, periodFixture(21, 101));
    const text = normalize((await extract(await generatePeriodReportPdf(report))).join(""));
    for (const finding of report.findings) expect(text).toContain(`候補#${finding.findingId}:`);
    for (const run of report.runs) expect(text).toContain(`run#${run.runId}／開始`);
    expect(text).toContain("新規候補数:101件"); expect(text).toContain("レポートの範囲と原文確認");
  }, 30_000);
  it.each(["bytes", "characters", "pages", "milliseconds"] as const)("rejects the whole PDF at the %s limit", async key => {
    Object.assign(PERIOD_PDF_LIMITS, { [key]: key === "pages" ? 1 : 2 });
    await expect(generatePeriodReportPdf(buildPeriodReport(7, fixturePeriod, periodFixture(2, 10)))).rejects.toMatchObject({ reason: "limit" });
  });
});
