import { readFile } from "node:fs/promises";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchPatentWatchStatus,
  isPatentWatchUnavailable,
  patentWatchRunErrorState,
  PatentWatchSection,
  PatentWatchSectionView,
  type PatentWatchFetch,
  type PatentWatchLoadState,
  type WatchRunView,
  type WatchSummary,
} from "./watch-section";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const SECTION_SOURCE_URL = new URL("./watch-section.tsx", import.meta.url);
const CASE_PAGE_SOURCE_URL = new URL("../page.tsx", import.meta.url);
const REPORT_PAGE_SOURCE_URL = new URL(
  "./runs/[runId]/page.tsx",
  import.meta.url,
);
const PRINT_BUTTON_SOURCE_URL = new URL(
  "./runs/[runId]/print-button.tsx",
  import.meta.url,
);

function run(
  status: WatchRunView["status"],
  overrides: Partial<WatchRunView> = {},
): WatchRunView {
  return {
    runId: 21,
    status,
    startedAt: "2096-03-01T00:00:00.000Z",
    completedAt:
      status === "running" ? null : "2096-03-01T00:01:00.000Z",
    scannedImportRunCount: 1,
    scannedDocumentCount: 2,
    prefilteredCount: 1,
    analyzedCount: 1,
    newFindingCount: 1,
    fallbackFindingCount: 0,
    analysisMode: status === "completed" ? "ai" : "none",
    errorCode: status === "failed" ? "watch_internal_error" : null,
    ...overrides,
  };
}

function summary(latestRun: WatchRunView | null): WatchSummary {
  return {
    setting: {
      watchId: 11,
      enabled: true,
      monitoringFromDate: "20960301",
      createdAt: "2096-03-01T00:00:00.000Z",
      updatedAt: "2096-03-01T00:00:00.000Z",
    },
    latestRun,
    unreviewedFindingCount: latestRun?.newFindingCount ?? 0,
    runs: latestRun ? [latestRun] : [],
    findings: [],
  };
}

function renderWatchState(
  state: PatentWatchLoadState,
  latestRun: WatchRunView | null,
): string {
  return renderToStaticMarkup(
    createElement(PatentWatchSectionView, {
      caseId: 7,
      summary: summary(latestRun),
      enabled: true,
      monitoringFromDate: "2096-03-01",
      state,
      message: null,
      onEnabledChange: () => undefined,
      onMonitoringFromDateChange: () => undefined,
      onSaveSetting: () => undefined,
      onStartRun: () => undefined,
      onUpdateReview: () => undefined,
    }),
  );
}

describe("patent watch UI contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the independent watch controls without starting a run", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const html = renderToStaticMarkup(
      createElement(PatentWatchSection, { caseId: 7 }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(html).toContain("出願後ウォッチング");
    expect(html).toContain("監視開始日");
    expect(html).toContain("設定を保存");
    expect(html).toContain("今すぐ監視");
  });

  it("renders every runtime state through the presentational view", () => {
    const scenarios: Array<{
      name: string;
      state: PatentWatchLoadState;
      latestRun: WatchRunView | null;
      expected: string;
    }> = [
      {
        name: "loading",
        state: "loading",
        latestRun: null,
        expected: "読み込み中",
      },
      {
        name: "running",
        state: "running",
        latestRun: run("running"),
        expected: "監視実行中",
      },
      {
        name: "completed",
        state: "ready",
        latestRun: run("completed"),
        expected: "監視完了",
      },
      {
        name: "failed",
        state: "failed",
        latestRun: run("failed"),
        expected: "監視失敗",
      },
      {
        name: "unavailable",
        state: "unavailable",
        latestRun: null,
        expected:
          "この環境ではウォッチング機能がまだ利用可能になっていません",
      },
      {
        name: "fallback",
        state: "fallback",
        latestRun: run("completed", {
          analysisMode: "fallback",
          fallbackFindingCount: 1,
        }),
        expected: "fallback・人による確認が必要",
      },
    ];

    for (const scenario of scenarios) {
      const html = renderWatchState(scenario.state, scenario.latestRun);
      expect(html, scenario.name).toContain(scenario.expected);
    }
  });

  it("fetches initial status once with GET and no run or corpus request", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: PatentWatchFetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify(summary(null)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const response = await fetchPatentWatchStatus(7, fetchImpl);

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      input: "/api/cases/7/watch",
      init: { method: "GET", cache: "no-store" },
    });
    expect(JSON.stringify(calls)).not.toContain("POST");
    expect(JSON.stringify(calls)).not.toContain("/koho-corpus");
  });

  it.each([
    [409, "watch_run_in_progress", "running"],
    [503, "watch_unavailable", "unavailable"],
    [503, "watch_corpus_unavailable", "unavailable"],
    [500, "watch_internal_error", "failed"],
  ] as const)(
    "maps run error %s/%s to %s",
    (status, code, expected) => {
      expect(patentWatchRunErrorState(status, code)).toBe(expected);
    },
  );

  it("classifies unavailable responses consistently for PUT and PATCH", () => {
    expect(isPatentWatchUnavailable(503, null)).toBe(true);
    expect(isPatentWatchUnavailable(500, "watch_unavailable")).toBe(true);
    expect(
      isPatentWatchUnavailable(500, "watch_corpus_unavailable"),
    ).toBe(true);
    expect(isPatentWatchUnavailable(400, "invalid_watch_setting")).toBe(false);
  });

  it("loads status only and keeps POST runs behind an explicit click", async () => {
    const source = await readFile(SECTION_SOURCE_URL, "utf8");

    expect(source).toContain("useEffect");
    expect(source).toContain("method: \"POST\"");
    expect(source).toContain("method: \"PUT\"");
    expect(source).toContain("method: \"PATCH\"");
    expect(source).toContain("fetchPatentWatchStatus(caseId)");
    expect(source).not.toContain("/koho-corpus");
    const effectStart = source.indexOf("useEffect(() => {");
    const effectEnd = source.indexOf("}, [loadWatch]);", effectStart);
    expect(effectStart).toBeGreaterThanOrEqual(0);
    expect(effectEnd).toBeGreaterThan(effectStart);
    const initialEffect = source.slice(effectStart, effectEnd);
    expect(initialEffect).toContain("void loadWatch()");
    expect(initialEffect).not.toContain("POST");
    expect(initialEffect).not.toContain("/koho-corpus");
  });

  it("shows all watch states, findings, history, report and CSV actions", async () => {
    const source = await readFile(SECTION_SOURCE_URL, "utf8");

    for (const label of [
      "読み込み中",
      "監視実行中",
      "監視完了",
      "監視失敗",
      "この環境ではウォッチング機能がまだ利用可能になっていません",
      "未確認候補",
      "fallback",
      "確認済みにする",
      "未確認に戻す",
      "過去の監視実行",
      "レポートを表示",
      "CSVをダウンロード",
    ]) {
      expect(source).toContain(label);
    }

    for (const forbidden of [
      "sourceKey",
      "contentSha256",
      "sourceSha256",
      "normalizedEntryPath",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("is added outside the existing numbered steps", async () => {
    const pageSource = await readFile(CASE_PAGE_SOURCE_URL, "utf8");

    expect(pageSource).toMatch(
      /import\s+\{\s*PatentWatchSection\s*\}\s+from\s+["']\.\/watch\/watch-section["']/,
    );
    expect(pageSource).toContain("<PatentWatchSection caseId={caseIdNum}");
    for (const step of [1, 2, 3, 4, 5]) {
      expect(pageSource).toContain(`id=\"step-${step}\"`);
    }
    for (const existingComponent of [
      "<UploadDraftForm",
      "<ExtractClaimsButton",
      "<GenerateQueriesButton",
      "<UploadCsvForm",
      "<UploadPatentFilesForm",
      "<KohoCorpusPicker",
      "<AnalyzeButton",
    ]) {
      expect(pageSource).toContain(existingComponent);
    }
    expect(pageSource).toContain("2. 請求項・構成要素");

    for (const forbiddenDirectCall of [
      "patentWatchRepo",
      "runPatentWatch",
      "screenPriorArt",
      "analyzeOverlap",
      "kohoCorpusRepo",
      "kohoImportRepo",
    ]) {
      expect(pageSource).not.toContain(forbiddenDirectCall);
    }
    expect(pageSource).not.toContain('from "@/lib/patent-watch/service"');
    expect(pageSource).not.toContain('from "@/lib/koho-corpus"');
  });

  it("preserves action messages while refreshing status", async () => {
    const source = await readFile(SECTION_SOURCE_URL, "utf8");

    expect(source).toMatch(
      /setMessage\("監視設定を保存しました。"\);\s*await loadWatch\(true\)/u,
    );
    expect(source).toMatch(
      /setMessage\("監視を完了しました。"\);\s*await loadWatch\(true\)/u,
    );
    expect(source).toMatch(
      /if \(errorState === "running"\) await loadWatch\(true\)/u,
    );
  });

  it("disables stale review and export actions while unavailable", async () => {
    const source = await readFile(SECTION_SOURCE_URL, "utf8");

    expect(source).toContain("disabled={unavailable || busy}");
    expect(source).toContain("{unavailable ? (");
    expect(source).toContain("利用不可");
  });

  it("provides a print-safe human-review report without private provenance", async () => {
    const [source, printButtonSource] = await Promise.all([
      readFile(REPORT_PAGE_SOURCE_URL, "utf8"),
      readFile(PRINT_BUTTON_SOURCE_URL, "utf8"),
    ]);

    expect(source).toContain(
      "本レポートは確認候補を整理するもので、法的判断ではありません",
    );
    expect(source).toContain("@media print");
    expect(source).toContain("<PrintButton");
    expect(printButtonSource).toContain("window.print()");
    expect(source).toContain("一致候補");
    expect(source).toContain("差分候補");
    expect(source).toContain("POSTGRES_INTEGER_MAX");
    expect(source).toContain("parsed <= POSTGRES_INTEGER_MAX");
    expect(source).toContain("sanitizePatentWatchAnalysis");
    expect(source).toContain("案件 #{caseId} の監視レポート");
    expect(source).not.toContain("caseRow.title");
    expect(source).toMatch(
      /boundedPatentWatchPublicText\(finding\.publicationNumber, 100\)/,
    );
    expect(source).toMatch(
      /boundedPatentWatchPublicText\(finding\.inventionTitle, 500\)/,
    );
    for (const forbidden of [
      "sourceKey",
      "contentSha256",
      "sourceSha256",
      "normalizedEntryPath",
      "claimsText",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
