"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type WatchSettingView = {
  watchId: number;
  enabled: boolean;
  monitoringFromDate: string;
  createdAt: string;
  updatedAt: string;
};

export type WatchRunView = {
  runId: number;
  status: "running" | "completed" | "failed";
  startedAt: string;
  completedAt: string | null;
  scannedImportRunCount: number;
  scannedDocumentCount: number;
  prefilteredCount: number;
  analyzedCount: number;
  newFindingCount: number;
  fallbackFindingCount: number;
  analysisMode: "none" | "ai" | "fallback";
  errorCode: string | null;
};

export type WatchFindingView = {
  findingId: number;
  firstRunId: number;
  packageType: string;
  kind: string;
  publicationNumber: string;
  publicationDate: string;
  inventionTitle: string;
  abstractPreview: string | null;
  lexicalScore: number;
  elementScore: number;
  semanticScore: number;
  structuralScore: number;
  riskLabel: string;
  matchedElements: string[];
  unmatchedElements: string[];
  explanation: string;
  analysisMode: "ai" | "fallback";
  reviewStatus: "unreviewed" | "reviewed";
  firstSeenAt: string;
};

export type WatchSummary = {
  setting: WatchSettingView | null;
  latestRun: WatchRunView | null;
  unreviewedFindingCount: number;
  runs: WatchRunView[];
  findings: WatchFindingView[];
};

export type PatentWatchLoadState =
  | "loading"
  | "ready"
  | "starting"
  | "running"
  | "failed"
  | "unavailable"
  | "fallback";

export type PatentWatchFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchPatentWatchStatus(
  caseId: number,
  fetchImpl: PatentWatchFetch = fetch,
  signal?: AbortSignal,
): Promise<Response> {
  return fetchImpl(`/api/cases/${caseId}/watch`, {
    method: "GET",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
}

export function patentWatchRunErrorState(
  status: number,
  code: string | null,
): PatentWatchLoadState {
  if (code === "watch_run_in_progress") return "running";
  if (isPatentWatchUnavailable(status, code)) return "unavailable";
  return "failed";
}

export function isPatentWatchUnavailable(
  status: number,
  code: string | null,
): boolean {
  return (
    status === 503 ||
    code === "watch_unavailable" ||
    code === "watch_corpus_unavailable"
  );
}

export type WatchAttempt = {
  kind: "completed" | "fallback" | "blocked" | "stopped" | "failed" | "unknown";
  message: string;
};

const ERROR_CODES = new Set([
  "watch_disabled", "watch_not_configured", "watch_claims_not_ready",
  "watch_run_in_progress", "invalid_watch_setting", "invalid_watch_run_request",
  "case_not_found", "watch_corpus_unavailable", "watch_unavailable",
  "watch_ai_stopped", "watch_analysis_failed", "watch_internal_error",
]);

function errorCode(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { code?: unknown; error?: unknown };
  const nested = value.error && typeof value.error === "object"
    ? (value.error as { code?: unknown }).code : value.error;
  const code = value.code ?? nested;
  return typeof code === "string" && ERROR_CODES.has(code) ? code : null;
}

// The deadline covers both headers and body. Never retry a write automatically.
async function watchResponse(
  request: (signal: AbortSignal) => Promise<Response>,
  timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await request(controller.signal);
        const body: unknown = await response.json().catch(() => null);
        return { response, body };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("watch_request_unconfirmed"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isWatchSummary(value: unknown): value is WatchSummary {
  if (!value || typeof value !== "object") return false;
  const data = value as WatchSummary;
  return (data.setting === null || (typeof data.setting === "object" &&
    data.setting !== undefined && typeof data.setting.enabled === "boolean" &&
    typeof data.setting.monitoringFromDate === "string")) &&
    (data.latestRun === null || isRun(data.latestRun)) &&
    Number.isSafeInteger(data.unreviewedFindingCount) && data.unreviewedFindingCount >= 0 &&
    Array.isArray(data.runs) && data.runs.every(isRun) && Array.isArray(data.findings);
}

function isRun(value: unknown): value is WatchRunView {
  if (!value || typeof value !== "object") return false;
  const run = value as WatchRunView;
  return Number.isSafeInteger(run.runId) && run.runId > 0 &&
    ["running", "failed", "completed"].includes(run.status) &&
    [run.scannedDocumentCount, run.prefilteredCount, run.analyzedCount,
      run.newFindingCount, run.fallbackFindingCount].every(n => Number.isSafeInteger(n) && n >= 0) &&
    ["none", "ai", "fallback"].includes(run.analysisMode);
}

function attemptLabel(kind: WatchAttempt["kind"]): string {
  switch (kind) {
    case "completed": return "今回の実行：監視完了";
    case "fallback": return "今回の実行：監視完了（fallback・人による確認が必要）";
    case "blocked": return "今回の実行：前提条件を確認してください";
    case "stopped": return "今回の実行：AI保護停止";
    case "failed": return "今回の実行：サーバーで処理失敗";
    case "unknown": return "今回の実行：結果不明";
  }
}

const UNKNOWN_ATTEMPT: WatchAttempt = {
  kind: "unknown",
  message: "応答を確認できず、今回の実行結果は不明です。保存済み履歴を確認してください。再読み込みは監視を再実行しません。結果不明のまま再実行せず、判断できない場合は管理者にお問い合わせください。",
};

function toDateInput(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
    : "";
}

function toApiDate(value: string): string {
  return value.replaceAll("-", "");
}

function dateTimeLabel(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("ja-JP", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

function publicationDateLabel(value: string): string {
  return /^\d{8}$/.test(value)
    ? `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`
    : value;
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function statusMessage(
  state: PatentWatchLoadState,
  latestRun: WatchRunView | null,
): string {
  if (state === "loading") return "読み込み中";
  if (state === "starting" || state === "running") return "監視実行中";
  if (state === "failed") return "監視失敗";
  if (latestRun?.status === "running") return "監視実行中";
  if (latestRun?.status === "failed") return "監視失敗";
  if (state === "fallback") {
    return "監視完了（fallback・人による確認が必要）";
  }
  if (latestRun?.status === "completed") return "監視完了";
  return "監視設定を保存してください";
}

function loadedState(latestRun: WatchRunView | null): PatentWatchLoadState {
  if (latestRun?.status === "running") return "running";
  if (latestRun?.status === "failed") return "failed";
  if ((latestRun?.fallbackFindingCount ?? 0) > 0) return "fallback";
  return "ready";
}

function safeErrorMessage(code: string | null): string {
  switch (code) {
    case "watch_disabled":
      return "ウォッチ設定が無効です。設定を有効にして保存してください。";
    case "watch_not_configured":
      return "先にウォッチ設定を保存してください。";
    case "watch_claims_not_ready":
      return "監視には抽出済みの請求項が必要です。";
    case "watch_run_in_progress":
      return "別の監視実行が進行中です。完了後に再読み込みしてください。";
    case "invalid_watch_setting":
      return "監視設定を確認してください。";
    case "watch_corpus_unavailable":
    case "watch_unavailable":
      return "この環境ではウォッチング機能がまだ利用可能になっていません。";
    case "case_not_found":
      return "対象の案件を確認できません。案件一覧から確認してください。";
    case "invalid_watch_run_request":
      return "実行要求を受け付けられませんでした。画面を再読み込みしてください。";
    case "watch_ai_stopped":
      return "AI処理を保護条件により停止しました。時間・入力・利用量の確認などにより停止する場合があります。保存済み履歴を確認し、続く場合は管理者にお問い合わせください。";
    default:
      return "サーバーで処理を完了できませんでした。保存済み履歴を確認し、続く場合は管理者にお問い合わせください。";
  }
}

export function PatentWatchSection({ caseId }: { caseId: number }) {
  const [summary, setSummary] = useState<WatchSummary | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [monitoringFromDate, setMonitoringFromDate] = useState("");
  const [state, setState] = useState<PatentWatchLoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  const [attempt, setAttempt] = useState<WatchAttempt | null>(null);
  const [snapshotFailed, setSnapshotFailed] = useState(false);
  const requestBusy = useRef(false);

  const loadWatch = useCallback(async (preserveMessage = false) => {
    setState("loading");
    if (!preserveMessage) setMessage(null);
    try {
      const { response, body } = await watchResponse(
        signal => fetchPatentWatchStatus(caseId, fetch, signal), 15_000,
      );
      if (!response.ok || !isWatchSummary(body)) {
        setSnapshotFailed(true);
        setState(isPatentWatchUnavailable(response.status, errorCode(body)) ? "unavailable" : "failed");
        return;
      }
      const data = body;
      setSnapshotFailed(false);
      setSummary(data);
      if (data.setting) {
        setEnabled(data.setting.enabled);
        setMonitoringFromDate(toDateInput(data.setting.monitoringFromDate));
      }
      setState(loadedState(data.latestRun));
    } catch {
      setSnapshotFailed(true);
      setState("failed");
    }
  }, [caseId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void loadWatch();
    });
    return () => {
      cancelled = true;
    };
  }, [loadWatch]);

  async function saveSetting() {
    if (requestBusy.current) return;
    requestBusy.current = true;
    setMessage(null);
    try {
      const { response, body } = await watchResponse(signal => fetch(`/api/cases/${caseId}/watch`, {
        method: "PUT", signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled, monitoringFromDate: toApiDate(monitoringFromDate) }),
      }), 15_000);
      if (!response.ok) {
        const code = errorCode(body);
        if (isPatentWatchUnavailable(response.status, code)) setState("unavailable");
        setMessage(safeErrorMessage(code));
        return;
      }
      setMessage("監視設定を保存しました。");
      await loadWatch(true);
    } catch {
      setMessage("設定保存の応答を確認できません。保存済み情報を再読み込みしてください。");
    } finally {
      requestBusy.current = false;
    }
  }

  async function startRun() {
    if (requestBusy.current || attempt?.kind === "unknown" || state === "loading" || !summary?.setting?.enabled) return;
    requestBusy.current = true;
    setState("starting");
    setMessage(null);
    setAttempt(null);
    try {
      const { response, body } = await watchResponse(signal => fetch(`/api/cases/${caseId}/watch/runs`, {
        method: "POST", signal,
      }), 125_000);
      if (!response.ok) {
        const code = errorCode(body);
        const kind = code === "watch_ai_stopped" ? "stopped"
          : code && !["watch_analysis_failed", "watch_internal_error"].includes(code) ? "blocked" : "failed";
        setAttempt(code ? { kind, message: safeErrorMessage(code) } : UNKNOWN_ATTEMPT);
      } else if (isRun(body) && body.status === "completed") {
        setAttempt({
          kind: body.analysisMode === "fallback" || body.fallbackFindingCount > 0 ? "fallback" : "completed",
          message: `今回の新着候補は${body.newFindingCount}件です。人による確認が必要です。`,
        });
      } else {
        setAttempt(UNKNOWN_ATTEMPT);
      }
    } catch {
      setAttempt(UNKNOWN_ATTEMPT);
    } finally {
      // Even an ambiguous POST can have persisted a failed/running/completed row.
      // GET refreshes saved data, but never establishes this attempt's success.
      await loadWatch(true);
      requestBusy.current = false;
    }
  }

  async function reloadWatch() {
    if (requestBusy.current) return;
    requestBusy.current = true;
    try { await loadWatch(true); }
    finally { requestBusy.current = false; }
  }

  async function updateReview(finding: WatchFindingView) {
    if (requestBusy.current) return;
    requestBusy.current = true;
    const reviewStatus = finding.reviewStatus === "reviewed" ? "unreviewed" : "reviewed";
    try {
      const { response, body } = await watchResponse(signal => fetch(
        `/api/cases/${caseId}/watch/findings/${finding.findingId}`, {
          method: "PATCH", signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ reviewStatus }),
        },
      ), 15_000);
      if (!response.ok) {
        const code = errorCode(body);
        if (isPatentWatchUnavailable(response.status, code)) setState("unavailable");
        setMessage(safeErrorMessage(code));
        return;
      }
      await loadWatch();
    } catch {
      setMessage("確認状態の更新応答を確認できません。保存済み情報を再読み込みしてください。");
    } finally {
      requestBusy.current = false;
    }
  }

  return (
    <PatentWatchSectionView
      caseId={caseId}
      summary={summary}
      enabled={enabled}
      monitoringFromDate={monitoringFromDate}
      state={state}
      message={message}
      attempt={attempt}
      snapshotFailed={snapshotFailed}
      onReload={() => void reloadWatch()}
      onEnabledChange={setEnabled}
      onMonitoringFromDateChange={setMonitoringFromDate}
      onSaveSetting={() => void saveSetting()}
      onStartRun={() => void startRun()}
      onUpdateReview={(finding) => void updateReview(finding)}
    />
  );
}

export type PatentWatchSectionViewProps = {
  caseId: number;
  summary: WatchSummary | null;
  enabled: boolean;
  monitoringFromDate: string;
  state: PatentWatchLoadState;
  message: string | null;
  attempt?: WatchAttempt | null;
  snapshotFailed?: boolean;
  onReload?: () => void;
  onEnabledChange: (enabled: boolean) => void;
  onMonitoringFromDateChange: (date: string) => void;
  onSaveSetting: () => void;
  onStartRun: () => void;
  onUpdateReview: (finding: WatchFindingView) => void;
};

export function PatentWatchSectionView({
  caseId,
  summary,
  enabled,
  monitoringFromDate,
  state,
  message,
  attempt = null,
  snapshotFailed = false,
  onReload,
  onEnabledChange,
  onMonitoringFromDateChange,
  onSaveSetting,
  onStartRun,
  onUpdateReview,
}: PatentWatchSectionViewProps) {
  const latestRun = summary?.latestRun ?? null;
  const unavailable = state === "unavailable";
  const busy =
    state === "loading" || state === "starting" || state === "running";
  const runButtonBusy = state === "loading" || state === "starting" || attempt?.kind === "unknown";

  return (
    <section className="mt-6 rounded-xl border-2 border-indigo-200 bg-indigo-50/40 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">出願後ウォッチング</h2>
          <p className="mt-1 text-sm text-gray-600">
            取り込み済み公報から、新たな重なり候補を明示操作で確認します。
          </p>
          <p className="mt-1 text-xs text-gray-500">
            表示内容は確認候補の整理であり、法的判断ではありません。
          </p>
        </div>
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-center">
          <div className="text-xs font-medium text-amber-800">取得済みの未確認候補</div>
          <div className="text-2xl font-bold text-amber-900">
            {summary ? summary.unreviewedFindingCount : "未取得"}
          </div>
        </div>
      </div>

      {attempt && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-white px-4 py-3" role="status">
          <p className="font-semibold">{attemptLabel(attempt.kind)}</p>
          <p className="mt-1 text-sm">{attempt.message}</p>
        </div>
      )}
      {state === "starting" && <p className="mt-3" role="status">今回の実行：監視実行中</p>}
      <div className="mt-4 text-sm text-gray-700">
        <p>保存済み情報：{state === "loading" ? "読み込み中" : snapshotFailed
          ? "最新情報は未取得です。最後に取得できた情報を表示しています。"
          : "取得済み（今回の操作結果とは別です）"}</p>
        {unavailable && <p>この環境ではウォッチング機能がまだ利用可能になっていません</p>}
        {summary && <p>保存済みの最新実行：{statusMessage(loadedState(latestRun), latestRun)}</p>}
        <button type="button" onClick={onReload} disabled={state === "loading" || state === "starting"}
          className="mt-2 rounded border border-gray-300 bg-white px-3 py-2 disabled:opacity-50">
          保存済み情報を再読み込み
        </button>
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border border-indigo-100 bg-white p-4 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            disabled={unavailable || busy}
          />
          ウォッチを有効にする
        </label>
        <label className="text-sm font-medium text-gray-700">
          監視開始日
          <input
            type="date"
            value={monitoringFromDate}
            onChange={(event) =>
              onMonitoringFromDateChange(event.target.value)
            }
            disabled={unavailable || busy}
            className="mt-1 block w-full rounded border border-gray-300 px-3 py-2"
          />
        </label>
        <button
          type="button"
          onClick={onSaveSetting}
          disabled={unavailable || busy || !monitoringFromDate}
          className="rounded bg-indigo-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          設定を保存
        </button>
        <button
          type="button"
          onClick={onStartRun}
          disabled={unavailable || runButtonBusy || !summary?.setting?.enabled}
          className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          今すぐ監視
        </button>
      </div>

      {message && (
        <p className="mt-3 rounded border border-gray-200 bg-white px-3 py-2 text-sm">
          {message}
        </p>
      )}

      {latestRun && (
        <div className="mt-4 rounded-lg border border-indigo-100 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">保存済みの最新実行</h3>
            <span className="text-sm text-gray-600">
              {dateTimeLabel(latestRun.completedAt ?? latestRun.startedAt)}
            </span>
            {latestRun.fallbackFindingCount > 0 && (
              <span className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-bold text-amber-800">
                fallback・人による確認が必要
              </span>
            )}
          </div>
          {latestRun.status === "failed" && <p className="mt-2 text-sm">{safeErrorMessage(ERROR_CODES.has(latestRun.errorCode ?? "") ? latestRun.errorCode : null)}</p>}
          <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-4">
            <div><dt className="text-gray-500">対象公報</dt><dd className="font-semibold">{latestRun.scannedDocumentCount}件</dd></div>
            <div><dt className="text-gray-500">事前絞り込み</dt><dd className="font-semibold">{latestRun.prefilteredCount}件</dd></div>
            <div><dt className="text-gray-500">分析</dt><dd className="font-semibold">{latestRun.analyzedCount}件</dd></div>
            <div><dt className="text-gray-500">新着候補</dt><dd className="font-semibold">{latestRun.status === "completed" ? `${latestRun.newFindingCount}件` : "未確定"}</dd></div>
          </dl>
        </div>
      )}

      <div className="mt-4 space-y-3">
        <h3 className="font-semibold">新着確認候補</h3>
        {!summary ? (
          <p className="text-sm text-gray-600">保存済みの確認候補は未取得です。</p>
        ) : summary.findings.length === 0 ? (
          <p className="text-sm text-gray-600">取得済みの保存情報に表示する確認候補はありません。今回の実行が正常0件だったことを示すものではありません。</p>
        ) : (
          summary.findings.map((finding) => (
            <article key={finding.findingId} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm font-semibold">{finding.publicationNumber}</span>
                <span className="text-sm text-gray-500">{publicationDateLabel(finding.publicationDate)}</span>
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{finding.kind}</span>
                <span className="rounded border border-rose-200 bg-rose-50 px-2 py-0.5 text-xs font-bold text-rose-800">{finding.riskLabel}</span>
                <span className="rounded border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs text-indigo-800">{finding.analysisMode}</span>
                <span className="ml-auto text-xs font-medium text-gray-600">{finding.reviewStatus === "reviewed" ? "確認済み" : "未確認"}</span>
              </div>
              <h4 className="mt-2 font-medium">{finding.inventionTitle}</h4>
              <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-600">
                <span>語彙 {percent(finding.lexicalScore)}</span>
                <span>要素 {percent(finding.elementScore)}</span>
                <span>意味 {percent(finding.semanticScore)}</span>
                <span>構造 {percent(finding.structuralScore)}</span>
              </div>
              <p className="mt-2 text-sm text-gray-700">{finding.explanation}</p>
              <button
                type="button"
                onClick={() => onUpdateReview(finding)}
                disabled={unavailable || busy}
                className="mt-3 rounded border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                {finding.reviewStatus === "reviewed" ? "未確認に戻す" : "確認済みにする"}
              </button>
            </article>
          ))
        )}
      </div>

      <div className="mt-5">
        <h3 className="font-semibold">過去の監視実行</h3>
        {!summary && <p className="mt-2 text-sm">保存済み履歴は未取得です。</p>}
        {summary && summary.runs.length === 0 && <p className="mt-2 text-sm">取得済みの保存情報に履歴はありません。</p>}
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="px-2 py-2">日時</th>
                <th className="px-2 py-2">状態</th>
                <th className="px-2 py-2">対象</th>
                <th className="px-2 py-2">新着</th>
                <th className="px-2 py-2">出力</th>
              </tr>
            </thead>
            <tbody>
              {summary?.runs.slice(0, 20).map((run) => (
                <tr key={run.runId} className="border-b border-gray-100">
                  <td className="px-2 py-2">{dateTimeLabel(run.completedAt ?? run.startedAt)}</td>
                  <td className="px-2 py-2">{run.status === "completed" ? "完了" : run.status === "failed" ? "失敗" : "実行中"}</td>
                  <td className="px-2 py-2">{run.scannedDocumentCount}件</td>
                  <td className="px-2 py-2">{run.status === "completed" ? `${run.newFindingCount}件` : "未確定"}</td>
                  <td className="px-2 py-2">
                    {unavailable ? (
                      <span className="text-gray-500">利用不可</span>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        <a className="text-indigo-700 underline" href={`/cases/${caseId}/watch/runs/${run.runId}`}>レポートを表示</a>
                        <a className="text-indigo-700 underline" href={`/api/cases/${caseId}/watch/report.csv?runId=${run.runId}`}>CSVをダウンロード</a>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
